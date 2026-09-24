"use strict";

function sanitizeId(value, fallback = "unknown") {
  const sanitized = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

function deviceIdFor(value) {
  const deviceId = sanitizeId(value, "xsense");
  const suffix = deviceId.match(/_0*(\d+)$/);
  if (!suffix) {
    return deviceId;
  }

  return suffix[1].padStart(3, "0");
}

function entityIdFor(entity, deviceId) {
  const entityId = sanitizeId(entity.objectId || entity.uniqueId, "state");
  const devicePrefix = `${sanitizeId(deviceId, "xsense")}_`;

  if (entityId.toLowerCase().startsWith(devicePrefix.toLowerCase())) {
    return sanitizeId(entityId.slice(devicePrefix.length), "state");
  }

  return entityId;
}

module.exports = {
  deviceIdFor,
  entityIdFor,
  sanitizeId,
};
