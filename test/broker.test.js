"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mqtt = require("mqtt");
const { EmbeddedMqttBroker, normalizeAddress, parseAllowedAddresses } = require("../lib/embeddedBroker");

const silentAdapter = {
  log: {
    debug() {},
    info() {},
    warn() {},
    error() {},
  },
};

test("normalizes IPv4-mapped addresses and parses allow lists", () => {
  assert.equal(normalizeAddress("::ffff:192.168.1.10"), "192.168.1.10");
  assert.equal(normalizeAddress("::1"), "127.0.0.1");
  assert.deepEqual(
    [...parseAllowedAddresses("192.168.1.10, 192.168.1.11")],
    ["192.168.1.10", "192.168.1.11"],
  );
});

test("accepts complete IPv4 networks in CIDR notation", () => {
  const allowed = parseAllowedAddresses("192.168.4.1/24, 10.20.30.40");

  assert.deepEqual([...allowed], ["192.168.4.0/24", "10.20.30.40"]);
  assert.equal(allowed.has("192.168.4.0"), true);
  assert.equal(allowed.has("192.168.4.255"), true);
  assert.equal(allowed.has("::ffff:192.168.4.25"), true);
  assert.equal(allowed.has("192.168.5.1"), false);
  assert.equal(allowed.has("10.20.30.40"), true);
});

test("rejects invalid CIDR rules", () => {
  assert.throws(
    () => parseAllowedAddresses("192.168.4.1/33"),
    /Invalid IPv4 CIDR rule/,
  );
});

test("accepts a publish through the embedded MQTT broker", async () => {
  let resolvePublish;
  const published = new Promise(resolve => {
    resolvePublish = resolve;
  });
  const broker = new EmbeddedMqttBroker(
    silentAdapter,
    {
      bindAddress: "127.0.0.1",
      port: 0,
      allowedClientAddresses: "127.0.0.0/8",
      requireAuthentication: false,
      username: "",
      password: "",
    },
    packet => resolvePublish({ topic: packet.topic, payload: packet.payload.toString("utf8") }),
    () => {},
  );

  await broker.start();
  const address = broker.address();
  const client = mqtt.connect(`mqtt://127.0.0.1:${address.port}`, {
    clientId: "xsense-mqtt-test",
    reconnectPeriod: 0,
  });

  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    await new Promise((resolve, reject) => {
      client.publish("homeassistant/binary_sensor/test/state", "ON", error =>
        error ? reject(error) : resolve(),
      );
    });
    assert.deepEqual(await published, {
      topic: "homeassistant/binary_sensor/test/state",
      payload: "ON",
    });
  } finally {
    await new Promise(resolve => client.end(false, {}, resolve));
    await broker.close();
  }
});
