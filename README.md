# Stream Deck Logitech G Hub Battery Monitor Plugin

## Plugin Features

- A reusable button category that when dragged onto your button automatically searches for compatible Logitech devices, and selects the first one by default.
- Selected devices are queried and shown a battery percentage level and an icon representing the percentage.
- A title is customizable to add a descriptive element to your button, in the case of multiple buttons where you need to distinguish your devices.
- The background color is also customizable via custom hex code.
- Different icons show depending on the battery level, whether or not the device is currently charging, and if the device is 'asleep' (or otherwise not found).

> [!NOTE]
> You need Logitech G Hub software (or at least the agent) to be running for the plugin to function, as it utilizes the websocket server that it runs to query the devices list and the device's battery levels.

> [!TIP]
> A "compatible device" is one that is wireless or otherwise has the ability to be charged. Your wireless mouse, keyboard, or headset should show up in the device's list. Your wired Yeti microphone should not.

## Development

The dev environment utilizes the [Stream Deck NodeJS SDK and CLI](https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/).\
Once the CLI is installed and you're in your root directory, you can initialize your development environment with `npm install`.\
To run the plugin in development hot reload mode, you can use `npm run watch`.

See the [Elgato documentation](https://docs.elgato.com/streamdeck/sdk/introduction/your-first-changes) for information on developing, modifying, and packing plugins.

## Testing

A personal checklist of (manual) integration tests to make sure everything functions correctly.

- Making a new Action accurately displays the first device.
- A second Action can be made and a new device selected, which doesn't change any other Actions.
- Changing the Device Name and any other settings works individually on each Action.
- Switching between pages does not unload any Actions or devices.
- Plugging in a device to charge shows the charging icon for that device only.
- When Streamdeck starts before G Hub, the Actions will eventually find the device list after G Hub is opened.
