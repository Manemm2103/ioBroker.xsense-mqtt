# Changelog

## 0.1.3 - 2026-09-24

- Add configurable display names for the short X-Sense device IDs

## 0.1.2 - 2026-09-24

- Stop creating per-entity `available` states and remove legacy availability objects during discovery
- Store each entity directly as a short data point such as `lifeend` instead of an entity channel containing `value`
- Shorten X-Sense device folders such as `SBS5015A996A7_00000003` to their three-digit suffix (`003`)

## 0.1.1 - 2026-09-24

- Align the GitHub repository name with the ioBroker adapter name so custom URL installation can locate the installed package

## 0.1.0 - 2026-09-24

- Initial local-only X-Sense SBS50 MQTT adapter
- Embedded Aedes MQTT broker with configurable bind IP and port
- Optional client-IP/CIDR allow list and username/password authentication
- Home Assistant MQTT discovery for sensors and binary sensors
