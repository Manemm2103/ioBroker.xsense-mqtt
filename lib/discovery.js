"use strict";

const SUPPORTED_COMPONENTS = new Set(["binary_sensor", "sensor"]);

function firstDefined(object, keys, fallback = undefined) {
  for (const key of keys) {
    if (object[key] !== undefined) {
      return object[key];
    }
  }
  return fallback;
}

function toText(payload) {
  return Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload ?? "");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseScalar(value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === "") {
    return "";
  }

  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return Number(trimmed);
  }

  if (/^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }

  return trimmed;
}

function valueFromTemplate(payload, template) {
  const text = toText(payload).trim();
  const parsed = parseJson(text);

  if (!template) {
    if (parsed && typeof parsed === "object") {
      if (parsed.value !== undefined) {
        return parsed.value;
      }
      if (parsed.state !== undefined) {
        return parsed.state;
      }
      return JSON.stringify(parsed);
    }
    return parseScalar(text);
  }

  const pathMatch = String(template).match(
    /value_json(?:\.([A-Za-z0-9_$.-]+)|\[['"]([^'"]+)['"]\])/,
  );
  if (!pathMatch || !parsed || typeof parsed !== "object") {
    return parseScalar(text);
  }

  const path = (pathMatch[1] || pathMatch[2]).split(".");
  let value = parsed;
  for (const segment of path) {
    if (value === null || typeof value !== "object" || value[segment] === undefined) {
      return null;
    }
    value = value[segment];
  }

  return value;
}

function normalizeBinaryValue(value, entity) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const onValue = String(entity.payloadOn ?? "ON").trim().toLowerCase();
  const offValue = String(entity.payloadOff ?? "OFF").trim().toLowerCase();

  if (normalized === onValue) {
    return true;
  }
  if (normalized === offValue) {
    return false;
  }

  if (["true", "1", "active", "alarm", "detected", "open"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "inactive", "normal", "clear", "closed"].includes(normalized)) {
    return false;
  }

  return Boolean(value);
}

function addRoute(routeMap, topic, entityKey) {
  if (!topic) {
    return;
  }
  if (!routeMap.has(topic)) {
    routeMap.set(topic, new Set());
  }
  routeMap.get(topic).add(entityKey);
}

function removeRoute(routeMap, topic, entityKey) {
  const route = routeMap.get(topic);
  if (!route) {
    return;
  }
  route.delete(entityKey);
  if (route.size === 0) {
    routeMap.delete(topic);
  }
}

class HomeAssistantDiscovery {
  constructor(options = {}) {
    this.prefix = String(options.prefix || "homeassistant").replace(/^\/+|\/+$/g, "");
    this.onEntity = options.onEntity || (async () => {});
    this.onValue = options.onValue || (async () => {});
    this.onAttributes = options.onAttributes || (async () => {});
    this.onAvailability = options.onAvailability || (async () => {});
    this.onUnknown = options.onUnknown || (async () => {});
    this.onWarning = options.onWarning || (() => {});
    this.entities = new Map();
    this.configTopics = new Map();
    this.stateRoutes = new Map();
    this.attributeRoutes = new Map();
    this.availabilityRoutes = new Map();
    this.lastPackets = new Map();
  }

  async handle(topic, payload, packet = {}) {
    const text = toText(payload);
    const discovery = this.parseDiscoveryTopic(topic);
    if (discovery) {
      await this.handleDiscoveryConfig(topic, text, discovery);
      return true;
    }

    this.rememberPacket(topic, text, packet);
    const handled = await this.dispatchTopic(topic, text, packet);
    if (!handled) {
      await this.onUnknown(topic, text, packet);
    }
    return handled;
  }

  parseDiscoveryTopic(topic) {
    const marker = `${this.prefix}/`;
    if (!topic.startsWith(marker)) {
      return null;
    }

    const parts = topic.slice(marker.length).split("/");
    if (parts.length < 3 || parts.at(-1) !== "config") {
      return null;
    }

    const component = parts[0];
    if (!SUPPORTED_COMPONENTS.has(component)) {
      return null;
    }

    return {
      component,
      objectId: parts.at(-2),
      nodeId: parts.slice(1, -2).join("_") || "xsense",
    };
  }

  async handleDiscoveryConfig(configTopic, text, discovery) {
    if (text.trim() === "") {
      this.removeEntityByConfigTopic(configTopic);
      return;
    }

    const config = parseJson(text);
    if (!config || typeof config !== "object") {
      this.onWarning(`Invalid Home Assistant discovery JSON on ${configTopic}`);
      return;
    }

    this.removeEntityByConfigTopic(configTopic);
    const entity = this.createEntity(configTopic, config, discovery);
    if (!entity.stateTopic) {
      this.onWarning(`Discovery entity ${entity.name} has no state_topic`);
      return;
    }

    this.entities.set(entity.key, entity);
    this.configTopics.set(configTopic, entity.key);
    addRoute(this.stateRoutes, entity.stateTopic, entity.key);
    addRoute(this.attributeRoutes, entity.attributesTopic, entity.key);
    addRoute(this.availabilityRoutes, entity.availabilityTopic, entity.key);
    await this.onEntity(entity);

    for (const routeTopic of [entity.stateTopic, entity.attributesTopic, entity.availabilityTopic]) {
      const previous = this.lastPackets.get(routeTopic);
      if (previous) {
        await this.dispatchTopic(routeTopic, previous.payload, previous.packet);
      }
    }
  }

  createEntity(configTopic, config, discovery) {
    const device = firstDefined(config, ["device", "dev"], {}) || {};
    const identifiers = firstDefined(device, ["identifiers", "ids"], []);
    const identifierList = Array.isArray(identifiers) ? identifiers : [identifiers];
    const uniqueId = firstDefined(config, ["unique_id", "uniq_id"]);
    const fallbackId = [discovery.nodeId, discovery.objectId].filter(Boolean).join("_");

    return {
      key: `${discovery.component}:${uniqueId || fallbackId}`,
      configTopic,
      component: discovery.component,
      nodeId: discovery.nodeId,
      objectId: discovery.objectId,
      uniqueId: uniqueId || fallbackId,
      name: firstDefined(config, ["name"], discovery.objectId),
      stateTopic: firstDefined(config, ["state_topic", "stat_t"]),
      attributesTopic: firstDefined(config, ["json_attributes_topic", "json_attr_t"]),
      availabilityTopic: firstDefined(config, ["availability_topic", "avty_t"]),
      valueTemplate: firstDefined(config, ["value_template", "val_tpl"]),
      payloadOn: firstDefined(config, ["payload_on", "pl_on"], "ON"),
      payloadOff: firstDefined(config, ["payload_off", "pl_off"], "OFF"),
      payloadAvailable: firstDefined(config, ["payload_available", "pl_avail"], "online"),
      payloadNotAvailable: firstDefined(config, ["payload_not_available", "pl_not_avail"], "offline"),
      deviceClass: firstDefined(config, ["device_class", "dev_cla"], ""),
      unit: firstDefined(config, ["unit_of_measurement", "unit_of_meas", "unit"]),
      device: {
        id: identifierList.find(Boolean) || discovery.nodeId || "xsense",
        name: firstDefined(device, ["name"], discovery.nodeId || "X-Sense"),
        manufacturer: firstDefined(device, ["manufacturer", "mf"], "X-Sense"),
        model: firstDefined(device, ["model", "mdl"], ""),
        softwareVersion: firstDefined(device, ["sw_version", "sw"], ""),
      },
      rawConfig: config,
    };
  }

  removeEntityByConfigTopic(configTopic) {
    const entityKey = this.configTopics.get(configTopic);
    if (!entityKey) {
      return;
    }

    const entity = this.entities.get(entityKey);
    if (entity) {
      removeRoute(this.stateRoutes, entity.stateTopic, entityKey);
      removeRoute(this.attributeRoutes, entity.attributesTopic, entityKey);
      removeRoute(this.availabilityRoutes, entity.availabilityTopic, entityKey);
    }
    this.entities.delete(entityKey);
    this.configTopics.delete(configTopic);
  }

  async dispatchTopic(topic, payload, packet) {
    let handled = false;

    const stateEntities = this.stateRoutes.get(topic) || [];
    for (const entityKey of stateEntities) {
      const entity = this.entities.get(entityKey);
      if (!entity) {
        continue;
      }
      let value = valueFromTemplate(payload, entity.valueTemplate);
      if (entity.component === "binary_sensor") {
        value = normalizeBinaryValue(value, entity);
      } else {
        value = parseScalar(value);
      }
      await this.onValue(entity, value, packet);
      handled = true;
    }

    const attributeEntities = this.attributeRoutes.get(topic) || [];
    if (attributeEntities.size > 0) {
      const attributes = parseJson(payload);
      if (attributes && typeof attributes === "object") {
        for (const entityKey of attributeEntities) {
          const entity = this.entities.get(entityKey);
          if (entity) {
            await this.onAttributes(entity, attributes, packet);
            handled = true;
          }
        }
      }
    }

    const availabilityEntities = this.availabilityRoutes.get(topic) || [];
    for (const entityKey of availabilityEntities) {
      const entity = this.entities.get(entityKey);
      if (!entity) {
        continue;
      }
      const available = String(payload).trim() === String(entity.payloadAvailable);
      await this.onAvailability(entity, available, packet);
      handled = true;
    }

    return handled;
  }

  rememberPacket(topic, payload, packet) {
    this.lastPackets.set(topic, { payload, packet });
    if (this.lastPackets.size > 500) {
      const oldest = this.lastPackets.keys().next().value;
      this.lastPackets.delete(oldest);
    }
  }
}

module.exports = {
  HomeAssistantDiscovery,
  normalizeBinaryValue,
  parseScalar,
  valueFromTemplate,
};
