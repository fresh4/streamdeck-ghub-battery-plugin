/* eslint-disable @typescript-eslint/explicit-member-accessibility */
import {
	action,
	DialAction,
	DidReceiveSettingsEvent,
	JsonObject,
	JsonValue,
	KeyAction,
	SendToPluginEvent,
	SingletonAction,
	WillAppearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import { Jimp } from "jimp";
import { RawData, WebSocket } from "ws";

import type { BatteryState, Device, DeviceList, Instance, MonitorSettings } from "../types";

let devices: Device[] = [];
let ws: WebSocket | null = null;

const instances = new Map<string, Instance>();

/**
 * This action connects to an existing G Hub instance via its dedicated Websocket server and
 * monitors it for changes and updates, including changes in battery percentage and plugged in status.
 *
 * Upon receiving updates, it changes the displayed icon and charged percentage value to match for the selected device.
 */
@action({ UUID: "com.fresh.ghub-battery.monitor" })
export class MonitorBattery extends SingletonAction<MonitorSettings> {
	// Handle change in user defined settings from UI.
	// eslint-disable-next-line jsdoc/require-jsdoc
	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<MonitorSettings>): Promise<void> | void {
		for (const [ctx, inst] of instances.entries()) {
			if (ev.action.id !== ctx) continue;
			if (ws) {
				inst.name = ev.payload.settings.name ?? "";
				inst.deviceId = ev.payload.settings.device ?? inst.deviceId;
				inst.backgroundColor = ev.payload.settings.bg ?? inst.backgroundColor;
				inst.spacing = ev.payload.settings.spacing ?? 2;
				websocketSend(ws, `/battery/${inst.deviceId}/state`);
			}
		}
	}

	// Respond to the UIs request to fill out the getDevices select field.
	// eslint-disable-next-line jsdoc/require-jsdoc
	override onSendToPlugin(ev: SendToPluginEvent<JsonValue, MonitorSettings>): Promise<void> | void {
		if (ev.payload instanceof Object && "event" in ev.payload && ev.payload.event === "getDevices") {
			streamDeck.ui.current?.sendToPropertyInspector({
				event: "getDevices",
				items: devices.map((device) => ({ label: device.displayName, value: device.id })),
			});
		}
	}

	// Runs once whenever a button instance "appears"; initial set up for websockets and event listeners.
	// eslint-disable-next-line jsdoc/require-jsdoc
	override onWillAppear(ev: WillAppearEvent<MonitorSettings>): Promise<void> | void {
		instances.set(ev.action.id, {
			deviceId: ev.payload.settings.device ?? "",
			name: ev.payload.settings.name ?? "",
			percentage: 100,
			charging: false,
			backgroundColor: ev.payload.settings.bg ?? "",
			spacing: ev.payload.settings.spacing ?? 2,
		});

		if (!ws) ws = getWebsocketConnection();
		if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ path: "/devices/list", verb: "GET" }));

		// Once the websocket connection is made, make the initial requests and subscriptions.
		ws.on("open", () => {
			initializeWebsocket(ws!);
		});

		// Handle every response returned from the websocket server.
		ws.on("message", (msg) => handleWebsocketMessage(msg));
	}
}

/**
 * @param msg The raw data returned by the Websocket server.
 */
function handleWebsocketMessage(msg: RawData): void {
	const payload: BatteryState | DeviceList = JSON.parse(msg.toString("utf-8"));

	// Handles logic upon receiving a new device list.
	if (ws && payload.path === "/devices/list") {
		const _ws = payload as DeviceList;

		devices = [];
		_ws.payload.deviceInfos.forEach((d) => {
			if (d && d.capabilities && d.capabilities.hasBatteryStatus) {
				devices.push(d);
			}
		});

		for (const [, inst] of instances.entries()) {
			const devId = inst.deviceId || devices[0].id;
			if (devId) {
				inst.deviceId = devId;
				websocketSend(ws, `/battery/${devId}/state`);
			}
		}
	}

	// Handles whenever the devices battery or charge state updates.
	// Includes updating the percentage value and battery image.
	if (payload.path.includes("/battery/")) {
		const _ws = payload as BatteryState;

		// Device not found, probably inactive.
		if (!_ws.payload) {
			for (const action of streamDeck.actions) {
				for (const [ctx, inst] of instances.entries()) {
					const failedDevice = _ws.path.split("/battery/")[1].split("/")[0];
					if (ctx == action.id && inst.deviceId == failedDevice) {
						setCompositeImage(action, "imgs/actions/monitor/asleep");
						action.setTitle("");
					}
				}
			}
			return;
		}

		// For the specific context and device, update its image and title to match what was
		// received from the websocket updates. Double for loop required for context matching.
		for (const action of streamDeck.actions) {
			for (const [ctx, inst] of instances.entries()) {
				if (inst.deviceId !== _ws.payload.deviceId) continue;

				inst.percentage = _ws.payload.percentage;
				inst.charging = _ws.payload.charging;
				const spacingValue = "\n".repeat(inst.spacing);
				const image = getBatteryImage(_ws);
				const title = inst.name ? `${inst.name}${spacingValue}${inst.percentage}%` : `${inst.percentage}%`;
				if (action.id == ctx) {
					setCompositeImage(action, image);
					action.setTitle(title);
				}
			}
		}
	}
}

/**
 *
 * @param ws The Websocket connection object.
 * @param path The route being called on the Websocket (ie, /devices/list)
 * @param verb The method used for that route (ie, GET, SUBSCRIBE, etc.)
 */
function websocketSend(ws: WebSocket, path: string, verb: string = "GET"): void {
	try {
		ws.send(JSON.stringify({ path: path, verb: verb }));
	} catch {
		streamDeck.logger.debug("There was an error sending the websocket request", path);
	}
}

// eslint-disable-next-line jsdoc/require-jsdoc
function getWebsocketConnection(): WebSocket {
	const ws = new WebSocket("ws://localhost:9010", "json", {
		headers: {
			origin: "file://",
			pragma: "no-cache",
			"cache-control": "no-cache",
			"sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
			"sec-websocket-protocol": "json",
		},
	});

	return ws;
}

/**
 * @param ws An instantiated Websocket object with an open connection.
 */
function initializeWebsocket(ws: WebSocket): void {
	// Get the device list for showing valid battery enabled devices.
	ws.send(JSON.stringify({ path: "/devices/list", verb: "GET" }));

	// Subscribe to the battery state change event to update battery and charging status display
	ws.send(JSON.stringify({ path: "/battery/state/changed", verb: "SUBSCRIBE" }));
}

/**
 *
 * @param bs Battery State object containing information about the devices battery state.
 * @returns A string representing the path to the image to be used
 */
function getBatteryImage(bs: BatteryState): string {
	const percentage = bs.payload.percentage;
	let fg = "";
	if (bs.payload.charging) {
		if (percentage >= 80) fg = "imgs/actions/monitor/charging-green";
		else if (percentage >= 40) fg = "imgs/actions/monitor/charging-orange";
		else fg = "imgs/actions/monitor/charging-red";
	} else {
		if (percentage == 100) fg = "imgs/actions/monitor/key-100";
		else if (percentage >= 95) fg = "imgs/actions/monitor/key-95";
		else if (percentage >= 90) fg = "imgs/actions/monitor/key-90";
		else if (percentage >= 80) fg = "imgs/actions/monitor/key-80";
		else if (percentage >= 70) fg = "imgs/actions/monitor/key-70";
		else if (percentage >= 60) fg = "imgs/actions/monitor/key-60";
		else if (percentage >= 50) fg = "imgs/actions/monitor/key-50";
		else if (percentage >= 40) fg = "imgs/actions/monitor/key-40";
		else if (percentage >= 30) fg = "imgs/actions/monitor/key-30";
		else if (percentage >= 20) fg = "imgs/actions/monitor/key-20";
		else if (percentage >= 10) fg = "imgs/actions/monitor/key-10";
		else if (percentage > 0) fg = "imgs/actions/monitor/key-10";
		else fg = "imgs/actions/monitor/key-0";
	}
	return fg;
}

/**
 * Creates a Stream Deck-compatible 72x72 image with a background color and an icon layered on top.
 * @param backgroundColor The chosen background color to display, e.g. "#FF0000"
 * @param iconPath Path to the icon to be layered atop the background
 * @returns Promise containing a base64 encoded image
 */
async function createCompositeImage(backgroundColor: string, iconPath: string): Promise<string> {
	const size = 72;

	// Create a blank image (defaults to black)
	const canvas = await new Jimp({ width: size, height: size });

	// Parse the background color (convert hex to ARGB integer)
	const hex = parseInt(`${backgroundColor.split("#")[1]}ff`, 16);

	// Fill with the background color
	canvas.scan(0, 0, size, size, (x, y, idx: number) => {
		canvas.bitmap.data.writeUInt32BE(hex, idx);
	});

	// Load and resize the icon
	const icon = await Jimp.read(`${iconPath}@2x.png`);
	await icon.resize({ w: 64 }); // maintain aspect ratio

	// Center the icon
	const offsetX = (size - icon.bitmap.width) / 2;
	const offsetY = (size - icon.bitmap.height) / 2;
	canvas.composite(icon, offsetX, offsetY);

	// Export as Base64 PNG
	const buffer = await canvas.getBuffer("image/png");
	return `data:image/png;base64,${buffer.toString("base64")}`;
}

/**
 * @param action Action object used to set the image for this instance
 * @param imagePath Path to the image we want to set
 * @param backgroundColor Hexadecimal string representing the background color
 */
function setCompositeImage(
	action: DialAction<JsonObject> | KeyAction<JsonObject>,
	imagePath: string,
	backgroundColor: string = "#12142D",
): void {
	const instance = instances.get(action.id);
	const bg = instance && instance.backgroundColor ? instance.backgroundColor : backgroundColor;
	createCompositeImage(bg, imagePath)
		.then((image64) => {
			action.setImage(image64);
		})
		.catch(() => {
			action.setImage(imagePath);
		});
}
