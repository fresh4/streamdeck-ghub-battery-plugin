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
let isConnecting = false; // Track connection attempts to avoid duplicates
let reconnectInterval: NodeJS.Timeout | null = null; // Store reconnection interval
const RECONNECT_INTERVAL_MS = 5000; // Retry every 5 seconds

const instances = new Map<string, Instance>();

// Track battery request retries for devices that aren't ready after sleep/wake
const batteryRetryTimers = new Map<string, NodeJS.Timeout>();
const BATTERY_RETRY_DELAY_MS = 2000; // Wait 2 seconds before retrying
const MAX_BATTERY_RETRIES = 5; // Maximum retry attempts
const batteryRetryCount = new Map<string, number>();

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
		const instance = instances.get(ev.action.id);
		if (!instance) return;

		instance.name = ev.payload.settings.name ?? "";
		instance.backgroundColor = ev.payload.settings.bg ?? instance.backgroundColor;
		instance.spacing = ev.payload.settings.spacing ?? 2;

		// Update device ID and look up the display name for reliable re-matching after sleep/wake
		const newDeviceId = ev.payload.settings.device ?? instance.deviceId;
		if (newDeviceId && newDeviceId !== instance.deviceId) {
			instance.deviceId = newDeviceId;
			// Find and store the display name for this device
			const matchedDevice = devices.find((d) => d.id === newDeviceId);
			if (matchedDevice) {
				instance.deviceDisplayName = matchedDevice.displayName;
				// Persist the display name back to settings
				ev.action.setSettings({
					...ev.payload.settings,
					deviceDisplayName: matchedDevice.displayName,
				});
			}
		}

		if (ws?.readyState === WebSocket.OPEN && instance.deviceId) {
			websocketSend(ws, `/battery/${instance.deviceId}/state`);
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
		if (ev.payload instanceof Object && "event" in ev.payload && ev.payload.event === "refreshDevices") {
			ws?.send(JSON.stringify({ path: "/devices/list", verb: "GET" }));
		}
	}

	// Runs once whenever a button instance "appears"; initial set up for websockets and event listeners.
	// eslint-disable-next-line jsdoc/require-jsdoc
	override onWillAppear(ev: WillAppearEvent<MonitorSettings>): Promise<void> | void {
		instances.set(ev.action.id, {
			deviceId: ev.payload.settings.device ?? "",
			deviceDisplayName: ev.payload.settings.deviceDisplayName ?? "",
			name: ev.payload.settings.name ?? "",
			percentage: ev.payload.settings.value ?? 100,
			charging: ev.payload.settings.pluggedIn ?? false,
			backgroundColor: ev.payload.settings.bg ?? "#12142D",
			spacing: ev.payload.settings.spacing ?? 2,
		});

		if (!ws && !isConnecting) startWebSocketConnection();
		websocketSend(ws!, "/devices/list", "GET");
	}
}

/**
 * Starts the WebSocket connection and sets up reconnection logic.
 */
function startWebSocketConnection(): void {
	if (isConnecting) return;
	isConnecting = true;

	ws = getWebsocketConnection();

	ws.on("open", () => {
		streamDeck.logger.info("WebSocket connected to G HUB");
		isConnecting = false;
		if (reconnectInterval) {
			clearInterval(reconnectInterval);
			reconnectInterval = null;
		}
		initializeWebsocket(ws!);
	});

	ws.on("message", (msg) => handleWebsocketMessage(msg));

	ws.on("error", (err) => {
		streamDeck.logger.error("WebSocket error:", err.message);
		cleanupWebSocket();
		scheduleReconnect();
	});

	ws.on("close", () => {
		streamDeck.logger.info("WebSocket closed");
		cleanupWebSocket();
		scheduleReconnect();
	});
}

/**
 * Cleans up the WebSocket connection.
 */
function cleanupWebSocket(): void {
	if (ws) {
		ws.removeAllListeners();
		ws = null;
	}
	isConnecting = false;

	// Clear any pending battery retry timers
	for (const timer of batteryRetryTimers.values()) {
		clearTimeout(timer);
	}
	batteryRetryTimers.clear();
	batteryRetryCount.clear();
}

/**
 * Schedules a reconnection attempt if not already scheduled.
 */
function scheduleReconnect(): void {
	if (reconnectInterval || instances.size === 0) return;
	reconnectInterval = setInterval(() => {
		if (!ws && !isConnecting) {
			streamDeck.logger.info("Attempting to reconnect to G HUB WebSocket");
			startWebSocketConnection();
		}
	}, RECONNECT_INTERVAL_MS);
}

/**
 * @param msg The raw data returned by the Websocket server.
 */
function handleWebsocketMessage(msg: RawData): void {
	const payload: BatteryState | DeviceList = JSON.parse(msg.toString("utf-8"));

	// Handles logic upon receiving a new device list.
	if (ws && payload.path === "/devices/list") {
		streamDeck.logger.debug("sent device list request");
		const deviceList = payload as DeviceList;
		if (!deviceList.payload.deviceInfos) {
			cleanupWebSocket();
			scheduleReconnect();
			return;
		}
		devices = deviceList.payload.deviceInfos.filter((d) => d?.capabilities?.hasBatteryStatus);

		// Clear all retry state since we have a fresh device list
		for (const timer of batteryRetryTimers.values()) {
			clearTimeout(timer);
		}
		batteryRetryTimers.clear();
		batteryRetryCount.clear();

		// Process device re-matching asynchronously to properly await getSettings
		void processDeviceList(ws);
	}

	// Handles whenever the devices battery or charge state updates.
	// Includes updating the percentage value and battery image.
	if (payload.path.includes("/battery/")) {
		const batteryState = payload as BatteryState;

		// Device not found, probably inactive or not ready after sleep/wake.
		if (!batteryState.payload) {
			const failedDevice = batteryState.path.split("/battery/")[1].split("/")[0];

			// Check if this device ID exists in the current device list from G Hub
			// This is more reliable than checking instances since device IDs change after sleep/wake
			const deviceExistsInGHub = devices.some((d) => d.id === failedDevice);

			if (!deviceExistsInGHub) {
				// This is a stale response for an old device ID that no longer exists in G Hub
				streamDeck.logger.debug(`Ignoring battery failure for stale device ID ${failedDevice} (not in current device list)`);
				batteryRetryCount.delete(failedDevice);
				const existingTimer = batteryRetryTimers.get(failedDevice);
				if (existingTimer) {
					clearTimeout(existingTimer);
					batteryRetryTimers.delete(failedDevice);
				}
				return;
			}

			// Check if we should retry - devices may not be ready immediately after sleep/wake
			const retryCount = batteryRetryCount.get(failedDevice) ?? 0;
			if (retryCount < MAX_BATTERY_RETRIES && ws?.readyState === WebSocket.OPEN) {
				// Clear any existing retry timer for this device
				const existingTimer = batteryRetryTimers.get(failedDevice);
				if (existingTimer) clearTimeout(existingTimer);

				// Schedule a retry
				batteryRetryCount.set(failedDevice, retryCount + 1);
				streamDeck.logger.info(
					`Battery request failed for ${failedDevice}, scheduling retry ${retryCount + 1}/${MAX_BATTERY_RETRIES}`,
				);

				const timer = setTimeout(() => {
					batteryRetryTimers.delete(failedDevice);
					if (ws?.readyState === WebSocket.OPEN) {
						websocketSend(ws, `/battery/${failedDevice}/state`);
					}
				}, BATTERY_RETRY_DELAY_MS);
				batteryRetryTimers.set(failedDevice, timer);
				return; // Don't show asleep icon yet while retrying
			}

			// Max retries reached or WebSocket not open, show asleep icon
			streamDeck.logger.info(`Device ${failedDevice} not responding after ${retryCount} retries, showing asleep`);
			batteryRetryCount.delete(failedDevice); // Reset for next time

			for (const action of streamDeck.actions) {
				const instance = instances.get(action.id);
				if (instance?.deviceId === failedDevice) {
					setCompositeImage(action, "imgs/actions/monitor/asleep");
					action.setTitle("");
				}
			}
			return;
		}

		// Battery request succeeded - clear retry count for this device
		batteryRetryCount.delete(batteryState.payload.deviceId);

		// For the specific context and device, update its image and title to match what was
		// received from the websocket updates.
		for (const action of streamDeck.actions) {
			const instance = instances.get(action.id);
			if (instance?.deviceId !== batteryState.payload.deviceId) continue;

			instance.percentage = batteryState.payload.percentage;
			instance.charging = batteryState.payload.charging;
			const spacingValue = "\n".repeat(instance.spacing);
			const image = getBatteryImage(batteryState);
			const title = instance.name
				? `${instance.name}${spacingValue}${instance.percentage}%`
				: `${instance.percentage}%`;
			setCompositeImage(action, image);
			action.setTitle(title);
		}
	}
}

/**
 * Processes the device list and re-matches devices after sleep/wake cycles.
 * This is async to properly await getSettings() for each action.
 * @param wsConnection The active WebSocket connection
 */
async function processDeviceList(wsConnection: WebSocket): Promise<void> {
	for (const [actionId, inst] of instances.entries()) {
		const originalDevId = inst.deviceId;
		let devId = originalDevId;
		let matchedDevice: Device | undefined;

		// Validate that the saved device ID still exists in the current device list
		// G HUB assigns dynamic IDs that can change after sleep/wake cycles
		matchedDevice = devices.find((d) => d.id === devId);

		if (!matchedDevice && devId) {
			// Device ID no longer valid - try to re-match by G HUB display name first
			if (inst.deviceDisplayName) {
				matchedDevice = devices.find((d) => d.displayName === inst.deviceDisplayName);
				if (matchedDevice) {
					streamDeck.logger.info(
						`Device ID changed after sleep/wake, re-matched "${inst.deviceDisplayName}" to ${matchedDevice.id}`,
					);
				}
			}

			// If still not found, try matching by user's custom name as fallback
			if (!matchedDevice && inst.name) {
				matchedDevice = devices.find((d) =>
					d.displayName.toLowerCase().includes(inst.name.toLowerCase()),
				);
				if (matchedDevice) {
					streamDeck.logger.info(
						`Device ID changed, re-matched by custom name "${inst.name}" to ${matchedDevice.id}`,
					);
				}
			}

			// Last resort: fall back to first available device
			if (!matchedDevice && devices.length > 0) {
				streamDeck.logger.info(`Device ID ${devId} no longer valid, falling back to first device`);
				matchedDevice = devices[0];
			}

			devId = matchedDevice?.id || "";
		} else if (!devId && devices.length > 0) {
			// No device set yet, use first available
			matchedDevice = devices[0];
			devId = matchedDevice.id;
		}

		if (devId && matchedDevice) {
			inst.deviceId = devId;
			inst.deviceDisplayName = matchedDevice.displayName;

			// Persist the updated device ID and display name back to Stream Deck settings if changed
			if (devId !== originalDevId || !inst.deviceDisplayName) {
				const action = [...streamDeck.actions].find((a) => a.id === actionId);
				if (action) {
					try {
						// Get current settings to preserve all existing values
						const currentSettings = await action.getSettings<MonitorSettings>();
						// Merge with updated device info
						await action.setSettings({
							...currentSettings,
							device: devId,
							deviceDisplayName: matchedDevice.displayName,
						});
						streamDeck.logger.debug(
							`Persisted updated device settings for action ${actionId}: device=${devId}, displayName=${matchedDevice.displayName}`,
						);
					} catch (err) {
						streamDeck.logger.error(`Failed to persist settings for action ${actionId}:`, err);
					}
				}
			}
			websocketSend(wsConnection, `/battery/${devId}/state`);
		}
	}

	// Notify Property Inspector of updated device list
	streamDeck.ui.current?.sendToPropertyInspector({
		event: "getDevices",
		items: devices.map((device) => ({ label: device.displayName, value: device.id })),
	});
}

/**
 *
 * @param ws The Websocket connection object.
 * @param path The route being called on the Websocket (ie, /devices/list)
 * @param verb The method used for that route (ie, GET, SUBSCRIBE, etc.)
 */
function websocketSend(ws: WebSocket, path: string, verb: string = "GET"): void {
	try {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ path, verb }));
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
