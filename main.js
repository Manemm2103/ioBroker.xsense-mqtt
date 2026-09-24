"use strict";

const utils = require("@iobroker/adapter-core");
const { EmbeddedMqttBroker } = require("./lib/embeddedBroker");
const { HomeAssistantDiscovery } = require("./lib/discovery");
const { deviceIdFor, entityIdFor, parseDeviceAliases, sanitizeId } = require("./lib/objectIds");

function stateDefinition(entity) {
  const deviceClass = String(entity.deviceClass || "").toLowerCase();
  const numericClasses = new Set([
    "battery",
    "carbon_monoxide",
    "humidity",
    "signal_strength",
    "temperature",
    "voltage",
  ]);

  if (entity.component === "binary_sensor") {
    const roles = {
      smoke: "indicator.alarm.fire",
      moisture: "indicator.alarm.water",
      connectivity: "indicator.connected",
      problem: "indicator.maintenance",
    };
    return {
      type: "boolean",
      role: roles[deviceClass] || "indicator",
    };
  }

  const roles = {
    battery: "value.battery",
    humidity: "value.humidity",
    temperature: "value.temperature",
    timestamp: "date",
  };
  return {
    type: numericClasses.has(deviceClass) || entity.unit ? "number" : "mixed",
    role: roles[deviceClass] || "value",
  };
}

class XSenseMqtt extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "xsense-mqtt",
    });

    this.broker = null;
    this.entityStateIds = new Map();
    this.deviceAliases = new Map();
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  async onReady() {
    await this.setStateAsync("info.connection", { val: false, ack: true });
    await this.setStateAsync("info.clients", { val: 0, ack: true });
    this.deviceAliases = parseDeviceAliases(this.config.deviceAliases);

    let brokerOptions;
    try {
      brokerOptions = this.readBrokerOptions();
    } catch (error) {
      this.log.error(`Invalid MQTT configuration: ${error.message}`);
      return;
    }
    if (!brokerOptions.requireAuthentication && brokerOptions.bindAddress === "0.0.0.0") {
      this.log.warn(
        "The MQTT broker listens on all interfaces without authentication. Restrict allowed client IPs/networks or enable authentication.",
      );
    }

    const discovery = new HomeAssistantDiscovery({
      prefix: this.config.discoveryPrefix || "homeassistant",
      onEntity: entity => this.ensureEntity(entity),
      onValue: (entity, value) => this.writeEntityValue(entity, value),
      onAttributes: (entity, attributes) => this.writeAttributes(entity, attributes),
      onUnknown: (topic, payload) => this.writeUnknownTopic(topic, payload),
      onWarning: message => this.log.warn(message),
    });

    try {
      this.broker = new EmbeddedMqttBroker(
        this,
        brokerOptions,
        async packet => {
          if (this.config.logMessages) {
            this.log.debug(`MQTT ${packet.topic}: ${packet.payload.toString("utf8")}`);
          }
          await discovery.handle(packet.topic, packet.payload, {
            qos: packet.qos,
            retain: Boolean(packet.retain),
          });
        },
        count => this.setStateAsync("info.clients", { val: count, ack: true }),
      );
      await this.broker.start();
      const brokerAddress = `mqtt://${brokerOptions.bindAddress}:${brokerOptions.port}`;
      await this.setStateAsync("info.broker", { val: brokerAddress, ack: true });
      await this.setStateAsync("info.connection", { val: true, ack: true });
      this.log.info(`Embedded MQTT broker listening on ${brokerAddress}`);
    } catch (error) {
      this.log.error(`Cannot start embedded MQTT broker: ${error.message}`);
      await this.setStateAsync("info.connection", { val: false, ack: true });
    }
  }

  readBrokerOptions() {
    const port = Number(this.config.mqttPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid MQTT port: ${this.config.mqttPort}`);
    }

    const requireAuthentication = Boolean(this.config.requireAuthentication);
    const username = String(this.config.mqttUsername || "");
    const password = String(this.config.mqttPassword || "");
    if (requireAuthentication && (!username || !password)) {
      throw new Error("MQTT authentication is enabled, but username or password is empty");
    }

    return {
      bindAddress: String(this.config.mqttBindAddress || "0.0.0.0").trim(),
      port,
      allowedClientAddresses: this.config.allowedClientAddresses,
      requireAuthentication,
      username,
      password,
    };
  }

  async ensureEntity(entity) {
    const legacyDeviceId = sanitizeId(entity.device.id, "xsense");
    const deviceId = deviceIdFor(legacyDeviceId);
    const entityId = entityIdFor(entity, legacyDeviceId);
    const stateId = `devices.${deviceId}.${entityId}`;
    const definition = stateDefinition(entity);

    const legacyDeviceObjectId = `devices.${legacyDeviceId}`;
    if (legacyDeviceId !== deviceId && (await this.getObjectAsync(legacyDeviceObjectId))) {
      await this.delObjectAsync(legacyDeviceObjectId, { recursive: true });
    }

    await this.extendObjectAsync(`devices.${deviceId}`, {
      type: "device",
      common: {
        name: this.deviceAliases.get(deviceId) || entity.device.name || deviceId,
      },
      native: {
        id: entity.device.id,
        manufacturer: entity.device.manufacturer,
        model: entity.device.model,
        softwareVersion: entity.device.softwareVersion,
      },
    });

    const legacyEntityId = sanitizeId(entity.uniqueId || entity.objectId, "state");
    const legacyChannelId = `devices.${deviceId}.${legacyEntityId}`;
    if (legacyChannelId !== stateId && (await this.getObjectAsync(legacyChannelId))) {
      await this.delObjectAsync(legacyChannelId, { recursive: true });
    }
    const currentObject = await this.getObjectAsync(stateId);
    if (currentObject && currentObject.type !== "state") {
      await this.delObjectAsync(stateId, { recursive: true });
    }

    await this.extendObjectAsync(stateId, {
      type: "state",
      common: {
        name: entity.name || entityId,
        type: definition.type,
        role: definition.role,
        read: true,
        write: false,
        ...(entity.unit ? { unit: entity.unit } : {}),
      },
      native: {
        component: entity.component,
        deviceClass: entity.deviceClass,
        discoveryTopic: entity.configTopic,
        stateTopic: entity.stateTopic,
      },
    });

    this.entityStateIds.set(entity.key, stateId);
  }

  async writeEntityValue(entity, value) {
    if (!this.entityStateIds.has(entity.key)) {
      await this.ensureEntity(entity);
    }
    await this.setStateAsync(this.entityStateIds.get(entity.key), {
      val: value,
      ack: true,
    });
  }

  async writeAttributes(entity, attributes) {
    if (!this.entityStateIds.has(entity.key)) {
      await this.ensureEntity(entity);
    }
    const entityStateId = this.entityStateIds.get(entity.key);
    const attributesChannelId = `${entityStateId}_attributes`;

    await this.extendObjectAsync(attributesChannelId, {
      type: "channel",
      common: {
        name: `${entity.name || entityIdFor(entity, entity.device.id)} attributes`,
      },
      native: {},
    });

    for (const [name, rawValue] of Object.entries(attributes)) {
      const stateId = `${attributesChannelId}.${sanitizeId(name, "attribute")}`;
      const value =
        rawValue !== null && typeof rawValue === "object" ? JSON.stringify(rawValue) : rawValue;
      const type = ["string", "number", "boolean"].includes(typeof value) ? typeof value : "string";

      await this.extendObjectAsync(stateId, {
        type: "state",
        common: {
          name,
          type,
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      });
      await this.setStateAsync(stateId, {
        val: value === null || value === undefined ? null : value,
        ack: true,
      });
    }
  }

  async writeUnknownTopic(topic, payload) {
    if (!this.config.storeUnknownTopics || topic.startsWith("$SYS/")) {
      return;
    }

    const parts = topic.split("/").map(part => sanitizeId(part, "topic"));
    const stateId = `raw.${parts.join(".")}`.slice(0, 220);
    await this.setObjectNotExistsAsync(stateId, {
      type: "state",
      common: {
        name: topic,
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: {
        mqttTopic: topic,
      },
    });
    await this.setStateAsync(stateId, { val: payload, ack: true });
  }

  async onUnload(callback) {
    try {
      await this.setStateAsync("info.connection", { val: false, ack: true });
      await this.setStateAsync("info.clients", { val: 0, ack: true });
      if (this.broker) {
        await this.broker.close();
      }
      callback();
    } catch (error) {
      this.log.warn(`Error while stopping MQTT broker: ${error.message}`);
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = options => new XSenseMqtt(options);
} else {
  new XSenseMqtt();
}
