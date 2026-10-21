# Device Inspector

Available from KonX 0.7.0 under **Network Tools → Device Inspector**.

## Try it without a switch

Choose **Load demo** to inspect two synthetic Cisco-style switches and a connected endpoint. The demo uses documentation addresses and does not connect to a network. Search for `192.0.2.100` or the endpoint MAC shown in the ARP table to explore the observed switch-port candidates.

## Collect from devices

1. Open SSH terminal connections to the Cisco IOS/IOS-XE devices you want to inspect. Complete login and host-key verification in the normal terminal workflow.
2. In Device Inspector, refresh the connection list and select the devices.
3. Choose **Collect**. KonX opens a separate SSH channel on each selected connection, so command output does not mix with your terminal input.
4. Inspect the interfaces, VLANs, MAC and ARP tables, CDP/LLDP neighbors, and PoE observations. Use the original command output to verify a finding.
5. Search for an IPv4 address or MAC address. Connect all relevant switches before collecting to provide more path evidence. Open the associated terminal from a result when further inspection is needed.

Collection uses fixed `show` commands and disables paging only in its own shell session. It does not change device configuration or escalate privilege. Your account must already have permission to run the commands. Cancel stops the collection channel while retaining the existing SSH terminal.

## Reports and evidence

Export JSON to retain timestamps, original command output, parsed observations, and warnings. Load an exported report for offline analysis. Reports contain device configuration and operational details where collected; review them before sharing.

An unavailable command, timeout, paginated output, or parser limitation is shown as incomplete coverage. Unknown values do not become zeros or a healthy status. Interface names are normalized for matching while source names and command references remain available.

## What a trace means

A MAC-table match shows where a switch observed a MAC address. An ARP entry links an observed IP address to a MAC. Neighbor information can connect observations across switches. These records can be stale, incomplete, or taken at different moments.

Multiple VLANs, duplicate IPs, port channels, missing switches, and ambiguous neighbors can leave multiple candidates. An apparent endpoint port is not proof of the cable's final destination. Read the trace warnings and original evidence before acting.

The first release targets common Cisco IOS/IOS-XE output formats. NX-OS, other vendors, VRF-specific collection, and automatic device discovery are outside its supported collection scope. Automated local SSH fixtures do not establish interoperability with every Cisco release.

Cisco documents these operational commands in its [interface and hardware command reference](https://www.cisco.com/c/en/us/td/docs/switches/lan/catalyst9300/software/release/17-9/command_reference/b_179_9300_cr/interface_and_hardware_commands.html). Command availability and output vary by platform and release.
