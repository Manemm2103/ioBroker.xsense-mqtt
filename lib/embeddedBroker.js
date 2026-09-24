"use strict";

const net = require("node:net");

function normalizeAddress(address) {
  if (!address) {
    return "";
  }

  if (address.startsWith("::ffff:")) {
    return address.slice(7);
  }

  return address === "::1" ? "127.0.0.1" : address;
}

function ipv4ToInteger(address) {
  return address
    .split(".")
    .reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function integerToIpv4(value) {
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join(".");
}

function parseAddressRule(value) {
  const rule = String(value).trim();
  if (!rule.includes("/")) {
    const address = normalizeAddress(rule);
    if (net.isIP(address) === 0) {
      throw new Error(`Invalid allowed MQTT client address: ${rule}`);
    }
    return {
      text: address,
      matches: candidate => normalizeAddress(candidate) === address,
    };
  }

  const parts = rule.split("/");
  const address = parts[0];
  const prefix = Number(parts[1]);
  if (
    parts.length !== 2 ||
    net.isIP(address) !== 4 ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    throw new Error(`Invalid IPv4 CIDR rule for MQTT clients: ${rule}`);
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4ToInteger(address) & mask) >>> 0;
  return {
    text: `${integerToIpv4(network)}/${prefix}`,
    matches: candidate => {
      const normalizedCandidate = normalizeAddress(candidate);
      return (
        net.isIP(normalizedCandidate) === 4 &&
        ((ipv4ToInteger(normalizedCandidate) & mask) >>> 0) === network
      );
    },
  };
}

class AddressAllowList extends Set {
  constructor(values) {
    const rules = values.map(parseAddressRule);
    super(rules.map(rule => rule.text));
    this.rules = rules;
  }

  has(address) {
    return this.rules.some(rule => rule.matches(address));
  }
}

function parseAllowedAddresses(value) {
  const values = String(value || "")
    .split(/[\s,;]+/)
    .map(address => address.trim())
    .filter(Boolean);
  return new AddressAllowList(values);
}

class EmbeddedMqttBroker {
  constructor(adapter, options, onPublish, onClientCountChanged) {
    this.adapter = adapter;
    this.options = options;
    this.onPublish = onPublish;
    this.onClientCountChanged = onClientCountChanged;
    this.allowedAddresses = parseAllowedAddresses(options.allowedClientAddresses);
    this.broker = null;
    this.server = null;
  }

  async start() {
    const { Aedes } = require("aedes");
    this.broker = await Aedes.createBroker({
      drainTimeout: 30000,
    });

    this.configureAuthentication();
    this.configureEvents();

    this.server = net.createServer(socket => {
      const remoteAddress = normalizeAddress(socket.remoteAddress);
      if (this.allowedAddresses.size > 0 && !this.allowedAddresses.has(remoteAddress)) {
        this.adapter.log.warn(`Rejected MQTT connection from ${remoteAddress || "unknown address"}`);
        socket.destroy();
        return;
      }

      this.broker.handle(socket);
    });

    await new Promise((resolve, reject) => {
      const onError = error => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };

      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.options.port, this.options.bindAddress);
    });

    this.server.on("error", error => {
      this.adapter.log.error(`MQTT server error: ${error.message}`);
    });
  }

  configureAuthentication() {
    if (!this.options.requireAuthentication) {
      return;
    }

    this.broker.authenticate = (_client, username, password, callback) => {
      const suppliedUsername = username ? username.toString() : "";
      const suppliedPassword = password ? password.toString() : "";
      const accepted =
        suppliedUsername === this.options.username && suppliedPassword === this.options.password;

      if (!accepted) {
        const error = new Error("Invalid MQTT username or password");
        error.returnCode = 4;
        callback(error, false);
        return;
      }

      callback(null, true);
    };
  }

  configureEvents() {
    const updateClientCount = () => {
      this.onClientCountChanged(this.broker.connectedClients || 0);
    };

    this.broker.on("clientReady", client => {
      this.adapter.log.info(`MQTT client connected: ${client.id}`);
      updateClientCount();
    });

    this.broker.on("clientDisconnect", client => {
      this.adapter.log.info(`MQTT client disconnected: ${client.id}`);
      updateClientCount();
    });

    this.broker.on("clientError", (client, error) => {
      this.adapter.log.warn(`MQTT client ${client?.id || "unknown"}: ${error.message}`);
    });

    this.broker.on("publish", (packet, client) => {
      if (!client || packet.topic.startsWith("$SYS/")) {
        return;
      }

      Promise.resolve(this.onPublish(packet, client)).catch(error => {
        this.adapter.log.error(`Cannot process MQTT topic ${packet.topic}: ${error.message}`);
      });
    });
  }

  async close() {
    if (this.broker) {
      await new Promise(resolve => {
        this.broker.close(() => resolve());
      });
      this.broker = null;
    }

    if (this.server) {
      await new Promise(resolve => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }
  }

  address() {
    return this.server?.address() || null;
  }
}

module.exports = {
  AddressAllowList,
  EmbeddedMqttBroker,
  normalizeAddress,
  parseAllowedAddresses,
};
