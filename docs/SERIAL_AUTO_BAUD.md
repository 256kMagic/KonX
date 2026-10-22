# Serial baud-rate detection

KonX 0.17.0 can try common serial speeds and select a likely baud rate from readable console output. This is intended for text consoles such as network equipment. It does not measure electrical timing or identify binary protocols.

## Saved serial sessions

1. Create or edit a session and choose **Serial**.
2. Select the COM port and set **Baud rate → Auto detect**.
3. Keep the device's expected data bits, parity, stop bits, and flow control. Detection changes only the baud rate.
4. Leave **Send Enter while detecting** off to listen without sending console text. Enable it if the device needs Enter to display its prompt: KonX then sends a carriage return at each tested rate and during confirmation.
5. Choose **Save & Connect**. The terminal shows progress and the selected numeric rate on success. Click **Cancel** in the progress overlay or choose **Cancel connection** from the tab or terminal menu to stop detection.

Saving Auto detect keeps that choice for subsequent connections. A detected speed does not overwrite the saved session. Choose a numeric baud rate if you want a fixed speed instead; existing numeric settings remain unchanged.

## Quick Connect

Enter `COM4@auto` in Quick Connect, or select **Serial** on Home and enter `auto` in the baud field. Replace COM4 with your device's port. A plain COM port still defaults to 9600 baud. Numeric forms such as `COM4@115200` remain available.

## What detection checks

KonX opens the port once, tries common baud rates, and checks bounded samples for readable console text or a recognizable prompt. It requires a single plausible rate and a fresh readable sample at that rate before connecting. Samples from candidate speeds are withheld from the terminal; the confirmed sample is shown after success.

The scan tries 9600, 115200, 57600, 38400, 19200, 4800, 2400, 1200, 230400, 460800, and 921600 baud. A rate unsupported by the adapter is skipped. The driver can accept a speed even when it does not match the connected device; see the [SerialPort stream API](https://serialport.io/docs/api-stream/).

Manual terminal input and BREAK are disabled during detection. Session logon actions start only after a successful connection. The optional Enter probe is the only console text the detector sends. Opening a serial port still uses normal driver control-line behavior.

## When no rate is selected

- **No readable output:** a silent console gives no evidence of its baud rate. Try again while the device is producing output, enable the Enter probe if appropriate for that console, or select a known rate manually.
- **More than one plausible rate:** KonX leaves the result unresolved. Select a rate manually and inspect the output.
- **Confirmation failed:** readable output from the first sample was not repeated. Try again with continuing output or use a known rate.
- **Port busy or unavailable:** disconnect the other serial session or application, check the USB adapter, and refresh the port list.
- **Binary data or incompatible framing:** choose a manual rate and the correct data/parity/stop/flow settings. Baud detection does not infer those settings or decode binary traffic.

A detected rate is an inference from the received text, not proof of the device's configured baud rate. Intermittent output, unusual encodings, noise, or adapters that return similar data at multiple speeds may prevent detection. Automated release checks use synthetic bindings and isolated profiles; physical adapter and device compatibility must be verified on the user's hardware.
