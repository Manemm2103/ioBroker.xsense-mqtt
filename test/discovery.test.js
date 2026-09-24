"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { HomeAssistantDiscovery, valueFromTemplate } = require("../lib/discovery");
const { deviceIdFor, entityIdFor, parseDeviceAliases } = require("../lib/objectIds");

test("uses the three-digit X-Sense device suffix", () => {
  assert.equal(deviceIdFor("SBS5015A996A7_00000001"), "001");
  assert.equal(deviceIdFor("SBS5015A996A7_00000003"), "003");
  assert.equal(deviceIdFor("1"), "001");
});

test("maps short or full device IDs to configured display names", () => {
  const aliases = parseDeviceAliases([
    { id: "1", name: "Flur" },
    { id: "SBS5015A996A7_00000003", name: "Wohnzimmer" },
    { id: "002", name: "" },
  ]);

  assert.deepEqual([...aliases], [
    ["001", "Flur"],
    ["003", "Wohnzimmer"],
  ]);
});

test("uses a short entity ID below the device", () => {
  assert.equal(
    entityIdFor(
      {
        objectId: "SBS5015A996A7_00000001_lifeend",
        uniqueId: "SBS5015A996A7_00000001_lifeend",
      },
      "SBS5015A996A7_00000001",
    ),
    "lifeend",
  );
});

test("discovers an X-Sense binary sensor and converts ON/OFF", async () => {
  const entities = [];
  const values = [];
  const discovery = new HomeAssistantDiscovery({
    onEntity: async entity => entities.push(entity),
    onValue: async (entity, value) => values.push({ entity, value }),
  });

  await discovery.handle(
    "homeassistant/binary_sensor/SBS50_A/smoke/config",
    JSON.stringify({
      name: "Smoke alarm",
      unique_id: "SBS50_A_smoke",
      state_topic: "xsense/SBS50_A/smoke",
      payload_on: "ON",
      payload_off: "OFF",
      device_class: "smoke",
      device: {
        identifiers: ["SBS50_A"],
        name: "Hallway",
      },
    }),
  );
  await discovery.handle("xsense/SBS50_A/smoke", "ON");

  assert.equal(entities.length, 1);
  assert.equal(entities[0].device.id, "SBS50_A");
  assert.equal(values.length, 1);
  assert.equal(values[0].value, true);
});

test("extracts a numeric value from a value_json template", async () => {
  const values = [];
  const discovery = new HomeAssistantDiscovery({
    onValue: async (_entity, value) => values.push(value),
  });

  await discovery.handle(
    "homeassistant/sensor/SBS50_A/battery/config",
    JSON.stringify({
      name: "Battery",
      unique_id: "SBS50_A_battery",
      state_topic: "xsense/SBS50_A/status",
      value_template: "{{ value_json.battery }}",
      device_class: "battery",
      unit_of_measurement: "%",
      device: { identifiers: ["SBS50_A"] },
    }),
  );
  await discovery.handle("xsense/SBS50_A/status", JSON.stringify({ battery: 87 }));

  assert.deepEqual(values, [87]);
});

test("replays a state packet received before its discovery config", async () => {
  const values = [];
  const discovery = new HomeAssistantDiscovery({
    onValue: async (_entity, value) => values.push(value),
  });

  await discovery.handle("xsense/SBS50_A/status", JSON.stringify({ battery: 55 }));
  await discovery.handle(
    "homeassistant/sensor/SBS50_A/battery/config",
    JSON.stringify({
      state_topic: "xsense/SBS50_A/status",
      value_template: "{{ value_json.battery }}",
      device: { identifiers: ["SBS50_A"] },
    }),
  );

  assert.deepEqual(values, [55]);
});

test("extracts bracket notation from Home Assistant templates", () => {
  assert.equal(valueFromTemplate('{"life_end":false}', "{{ value_json['life_end'] }}"), false);
});

test("handles the X-Sense status payload format", async () => {
  const values = [];
  const discovery = new HomeAssistantDiscovery({
    onValue: async (_entity, value) => values.push(value),
  });

  await discovery.handle(
    "homeassistant/binary_sensor/SBS50AABBCCDD_00000001/SBS50AABBCCDD_00000001_smokealarm/config",
    JSON.stringify({
      name: "Smoke alarm",
      unique_id: "SBS50AABBCCDD_00000001_smokealarm",
      state_topic:
        "homeassistant/binary_sensor/SBS50AABBCCDD_00000001/SBS50AABBCCDD_00000001_smokealarm/state",
      value_template: "{{ value_json.status }}",
      payload_on: "Detected",
      payload_off: "Cleared",
      device_class: "smoke",
      device: { identifiers: ["SBS50AABBCCDD_00000001"] },
    }),
  );
  await discovery.handle(
    "homeassistant/binary_sensor/SBS50AABBCCDD_00000001/SBS50AABBCCDD_00000001_smokealarm/state",
    '{"status":"Cleared"}',
  );

  assert.deepEqual(values, [false]);
});

test("consumes availability packets without exposing them as values or raw topics", async () => {
  const values = [];
  const unknownTopics = [];
  const discovery = new HomeAssistantDiscovery({
    onValue: async (_entity, value) => values.push(value),
    onUnknown: async topic => unknownTopics.push(topic),
  });

  await discovery.handle(
    "homeassistant/binary_sensor/SBS50_A/lifeend/config",
    JSON.stringify({
      unique_id: "SBS50_A_lifeend",
      state_topic: "xsense/SBS50_A/lifeend",
      availability_topic: "xsense/SBS50_A/availability",
      device: { identifiers: ["SBS50_A"] },
    }),
  );

  const handled = await discovery.handle("xsense/SBS50_A/availability", "online");

  assert.equal(handled, true);
  assert.deepEqual(values, []);
  assert.deepEqual(unknownTopics, []);
});
