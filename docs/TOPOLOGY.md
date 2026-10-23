# Visual Topology

Available from KonX 0.20.0. Visual Topology turns collected Device Inspector observations into an interactive map. It does not scan or connect when opened.

## Build a map

Load the included synthetic demo, import a Device Inspector report or a previous topology export, select a saved device snapshot, or send an existing collected report to the topology view. Importing a topology export rebuilds the map from its retained command evidence; saved graph claims are not trusted. The current age threshold and endpoint query apply when rebuilding. Refreshing the snapshot list reads local history. Use Device Inspector's explicit collection workflow to obtain fresh observations from connected Cisco IOS/IOS-XE devices.

Select a node to inspect its identity, recorded collection time, interface observations, and collection limits. Select a link to see its advertised local/remote ports, protocol, resolution status, and original command evidence. Device actions return to the existing connected terminal or related inspection tools.

Use **+**, **−**, and **Fit map** to change the view. Drag a node to rearrange it, or focus it and press the arrow keys. Drag empty canvas to pan. These positions are schematic and do not imply physical location. At narrow widths, the selected observation appears below the map. Select a source command button to view its numbered output lines, or open the same evidence in Device Inspector.

**Open terminal** only focuses the original SSH terminal when that exact connection remains connected. It does not reconnect, select another session with a similar name, or open a new connection.

CDP and LLDP advertisements provide neighbor evidence. A uniquely matching observed hostname or management address can resolve a neighbor to a collected device. Conflicting matches remain ambiguous, and neighbors outside the supplied collection remain separate unresolved nodes. A missing link does not establish that a connection is down.

## Trace an endpoint

Enter a complete MAC address or IPv4 address to overlay the existing Device Inspector forwarding-path analysis. MAC/ARP observations identify candidate forwarding ports. They do not prove physical endpoint attachment; stale tables, VLAN context, missing neighbors, and port channels can leave the result incomplete.

For IPv4 queries, retained ARP source references show the observed IP-to-MAC mapping. Forwarding links reference the MAC-table command. **Clear trace** removes the endpoint overlay without collecting new observations.

## Time and coverage

The map shows collection timestamps and an explicit age threshold. A record inside that threshold is still a saved observation, not a live status check. Unknown or future timestamps remain unknown. Individual device records may have been collected at different times.

The graph retains at most 256 nodes, 512 links, 16 source references per link, 128 endpoint matches, and 32 endpoint paths. A 256 KiB serialized graph limit can omit entries sooner. The map reports omitted entries, shortened display fields, and incomplete command coverage separately. The endpoint parser's own bounds and warnings remain visible. "All bounded graph entries shown" does not mean that every real device or link has been observed.

**Add to incident** uses the bounded graph with source references and short source-line excerpts. **Export JSON** also includes the canonical Device Inspector source report and full retained command output, up to 20 MiB. Exports can contain device names, addresses, operational details, and captured configuration including credentials. Review them before sharing or importing them into an incident. Graph and export limits never silently turn missing observations into evidence of absence.

See [Device Inspector](DEVICE_INSPECTOR.md) for collection scope and [Device Snapshots](DEVICE_SNAPSHOTS.md) for before/after comparisons.
