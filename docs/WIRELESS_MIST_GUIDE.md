# Wi-Fi Tools and Mist & Marvis

These tools are included in KonX 0.3.0. Open **Wi-Fi Tools** or **Mist & Marvis** from Home, the sidebar, or the Network Tools menu. Earlier 0.2.x executables do not include them.

## Local Wi-Fi tools

Click **Refresh Wi-Fi snapshot** to retrieve local Windows WLAN information. Opening the tab does not query adapters automatically.

- **Adapters and connection:** adapter state, current SSID/BSSID, signal quality, advertised authentication/encryption, and reported transmit/receive link rates.
- **Nearby networks:** cached BSSID observations with SSID, band, primary channel, frequency, RSSI, and signal quality. Filter by text and band; select a row for details.
- **Channels:** unique observed BSSIDs per primary channel, with relative count bars and the strongest observed RSSI.
- **Observations:** unencrypted networks, legacy WPA/WEP/TKIP, low current signal, shared channels, and missing evidence.
- **Export JSON:** save the current snapshot to a file you choose.

The survey uses Windows' native WLAN API, independent of the Windows display language. It reads the existing WLAN cache without requesting an active radio scan. The collection time is when KonX retrieved the cache; access-point observations can be older. Hidden or unavailable SSIDs and unsupported attributes remain identified explicitly.

Channel counts do not measure airtime utilization, spectrum interference, or client load. A physical access point can advertise several BSSIDs, and overlapping channels can still compete. Transmit/receive link rates are connection metadata rather than measured throughput. Advertised security does not establish the access point's complete configuration or the security of connected clients.

If Windows denies WLAN information, check **Settings > Privacy & security > Location** and your organization's policy. Check that the wireless radio and WLAN AutoConfig service are available. KonX reports unavailable evidence and does not change privacy settings, elevate, retrieve Wi-Fi passwords, associate to a network, or alter radio configuration. Inventory work runs in a separate bounded process and can be cancelled.

SSID/BSSID and adapter information can identify your networks. Snapshots remain local until you choose to export or share them. They are not sent to Mist automatically.

## Connect to Juniper Mist

1. Open **Mist & Marvis** and select the cloud region hosting your organization. KonX supports the twelve regions listed in the current Mist API reference.
2. Enter a Mist API token with the permissions needed for your organization/sites. An observer token is sufficient for the documented Marvis troubleshooting API.
3. Click **Save token**. KonX encrypts it for the current Windows account using Electron secure storage, then clears the input field.
4. Click **Test connection** to retrieve the token's authorized organization and site scopes. This is the first cloud request; opening the tab only reads local connection metadata.
5. Choose an organization and click **Load sites**, or select an authorized site returned by the connection test. Use **Access points** or **Wireless clients** to retrieve a snapshot.

For a restricted token whose scopes are not fully discovered, expand **Use known organization or site IDs** and enter the known UUIDs. Manual IDs take precedence over the corresponding selections; Mist continues to enforce the token's permissions. Changing the organization clears previous site targets and results.

API requests run in the main process over verified HTTPS to a fixed Mist regional endpoint. A saved key is never returned to the page. KonX refuses to save a key if secure encryption is unavailable. Changing clouds with a saved token requires entering a token for the new region or forgetting the old token first. **Forget token** removes the saved credential. KonX stores this integration separately from general settings in the profile's `mist.json`; it contains encrypted credential material and region metadata.

AP snapshots show identity, model, status, IP/MAC, client count, and selected radio details when Mist supplies them. Client snapshots show hostname, MAC/IP, SSID, associated AP, radio band/channel, RSSI/SNR, and last-seen metadata when available. Select a row to inspect the returned details. These views retrieve up to 200 records per request; larger inventories are marked limited. Use Mist's portal for the complete inventory where needed.

## Ask Marvis to troubleshoot

1. Choose your Mist organization.
2. Select a site, enter a device MAC address, or supply both to narrow the scope.
3. Choose **Wireless**, **Wired**, or **WAN**, plus **Last hour**, **Last day**, or **Last 7 days**.
4. Click **Ask Marvis Troubleshoot**.
5. Review the response from Marvis, including any problem categories, reasons, descriptions, and recommendations it returns. Use **Export JSON** to save the response and request scope.

This is a direct request to Mist's documented organization troubleshooting endpoint. It requires appropriate API permissions and a Marvis subscription at the organization level. The interface uses structured troubleshooting inputs. It does not simulate the portal's free-form conversational assistant or generate a separate AI interpretation of the response. The API key alone does not grant a missing subscription or expand its assigned permissions.

All available operations in this version read monitoring or troubleshooting data. KonX does not apply controller configuration changes, restart APs, or automatically act on Marvis recommendations. Local Wi-Fi snapshots and existing KonX documents are not uploaded as part of these requests.

## Errors, cancellation, and data handling

- **Unauthorized / 401:** verify the API key and selected Mist cloud.
- **Forbidden / 403:** verify token scope and permissions; for troubleshooting, check the organization Marvis entitlement.
- **Not found / 404:** check the organization/site identifiers and selected cloud.
- **Rate limited / 429:** wait for the displayed retry interval. KonX does not loop automatic retries.
- **Cancelled:** the active request or local inventory process stops. A previous completed report can remain visible with its original collection time.
- **Connection settings changed:** another Mist tab changed the key or region. Switch away and back to refresh local connection settings, then test the connection again. KonX checks the connection revision before sending a request from an older tab.
- **Secure connection or response error:** confirm network access to the selected API region. KonX verifies TLS, rejects redirects, limits response size to 2 MiB, and bounds cloud requests to 20 seconds.

Results are rendered as text. The application strips recognized credential fields and the configured API key from returned data, while retaining the network identities needed for troubleshooting. Exports can contain site names, addresses, client identities, and operational information; review the chosen report before sharing it. Credentials and results are not sent to a separate AI provider by this integration.

## API references

- [Mist API reference](https://www.juniper.net/documentation/us/en/software/mist/api/http/getting-started/how-to-get-started)
- [Troubleshoot a device or site using Marvis APIs](https://www.juniper.net/documentation/us/en/software/mist/mist-aiops/topics/concept/marvis-api-troubleshooting.html)
- [Official Mist OpenAPI specification](https://github.com/mistsys/mist_openapi)
- [Juniper Mist MCP server](https://www.juniper.net/documentation/us/en/software/mist/automation-integration/shared-content/topics/concept/about-juniper-mist-mcp.html) describes Juniper's separate conversational integration for compatible AI clients.
