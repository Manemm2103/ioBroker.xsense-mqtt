# ioBroker.xsense-mqtt

Lokaler ioBroker-Adapter fuer X-Sense-Geraete hinter einer SBS50-Bridge. Der Adapter enthaelt einen eigenen MQTT-Broker und benoetigt weder die X-Sense-Cloud noch ein X-Sense-Konto.

## Funktionen

- Eingebauter MQTT-Broker auf einer frei waehlbaren Bind-IP und einem frei waehlbaren Port
- Optionale Beschraenkung auf einzelne Client-IPs oder komplette IPv4-Netze per CIDR
- Optionale MQTT-Anmeldung mit Benutzername und Passwort
- Verarbeitung von Home-Assistant-MQTT-Discovery fuer `sensor` und `binary_sensor`
- Automatische ioBroker-Objekte fuer Messwerte, Alarmzustaende, Verfuegbarkeit und Attribute
- Unbekannte Topics koennen fuer die Fehlersuche unter `raw` gespeichert werden
- Keine Cloud-Anmeldung, kein AWS Cognito und kein Python

## Voraussetzungen

- ioBroker mit Node.js 22 oder neuer
- X-Sense SBS50 mit Firmware, die die lokale MQTT-/Home-Assistant-Anbindung unterstuetzt
- X-Sense-App ab Version 1.34 oder neuer fuer die Einrichtung der Bridge
- Ein freier TCP-Port auf dem ioBroker-Host, standardmaessig `1885`

## Installation aus GitHub

In ioBroker unter **Adapter -> Benutzerdefinierte Installation** die GitHub-URL dieses Repositories eintragen. Alternativ auf dem ioBroker-Host:

```sh
iobroker url https://github.com/Manemm2103/x-sense.iobroker --host YOUR_IOBROKER_HOST
```

Danach eine Instanz von `xsense-mqtt` anlegen.

## Einrichtung

1. Im Adapter die Bind-IP festlegen. `0.0.0.0` lauscht auf allen Netzwerkschnittstellen; die lokale IP des ioBroker-Hosts beschraenkt den Broker auf diese Schnittstelle.
2. Einen freien Port waehlen, zum Beispiel `1885`.
3. Optional unter **Erlaubte Client-IPs und Netze** die IP der SBS50 oder ein IPv4-Netz eintragen. `192.168.4.1/24` erlaubt beispielsweise alle Adressen von `192.168.4.0` bis `192.168.4.255`. Einzelne IPs und Netze koennen mit Komma kombiniert werden. Bei leerem Feld werden alle Clients akzeptiert.
4. Optional Benutzername und Passwort aktivieren.
5. Adapter speichern und neu starten.
6. In der X-Sense-App die SBS50 oeffnen und **Mit Home Assistant verbinden** auswaehlen.
7. Als Broker-Adresse die im LAN erreichbare IP des ioBroker-Hosts und den konfigurierten Port eintragen. Niemals `0.0.0.0` in der X-Sense-App verwenden.

Sobald die SBS50 verbunden ist, wird `xsense-mqtt.0.info.clients` groesser als `0`. Erkannte Geraete und Werte erscheinen unter `xsense-mqtt.0.devices`.

## Sicherheit

MQTT laeuft in dieser ersten Version unverschluesselt ueber TCP. Der Broker sollte deshalb nur im vertrauenswuerdigen lokalen Netz verwendet werden. Am besten die SBS50-IP oder das benoetigte lokale Netz unter **Erlaubte Client-IPs und Netze** eintragen oder die Anmeldung aktivieren. Port `1885` darf nicht ins Internet weitergeleitet werden.

## Wichtiger Hinweis

Dieser Adapter ist fuer Visualisierung und Automatisierung gedacht. Er ersetzt keine zertifizierte Alarmierung. Rauch- und CO-Melder muessen auch ohne ioBroker, Netzwerk und MQTT bestimmungsgemaess alarmieren.

## Entwicklung

```sh
npm install
npm test
npm run check
```

## Lizenz

MIT
