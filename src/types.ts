/**
 * Event object type definitions?
 */
export type MonitorSettings = {
	/**
	 * Charging percentage value.
	 */
	value?: number;
	/**
	 * Is the device plugged in and charging.
	 */
	pluggedIn?: boolean;
	/**
	 * The name of the device.
	 */
	name?: string;
	/**
	 * The ID of the device.
	 */
	device: string;

	/**
	 * Hexadecimal string for the background color.
	 */
	bg: string;
};

/**
 * Websocket /devices/list returned response object.
 */
export type DeviceList = {
	/**
	 * The path used for the websocket request.
	 */
	path: string;
	/**
	 * Websocket response payload object.
	 */
	payload: {
		/**
		 * List of devices returned by the Websocket route.
		 */
		deviceInfos: Device[];
	};
};

/**
 * Websocket /battery/<id>/state returned response object.
 */
export type BatteryState = {
	/**
	 * The path used for the websocket request.
	 */
	path: string;
	/**
	 * Websocket response payload object.
	 */
	payload: {
		/**
		 * Selected device's identifier (ie dev000000)
		 */
		deviceId: string;
		/**
		 * Devices current charged capacity.
		 */
		percentage: number;
		/**
		 * Whether or not the device is charging/plugged in.
		 */
		charging: boolean;
	};
};

/**
 * Represents a device, as defined by G Hub Websocket routes.
 */
export type Device = {
	/**
	 * String ID of the device (ie, dev0000000)
	 */
	id: string;
	/**
	 * Alternative numeric id. Not really used.
	 */
	pid: number;
	/**
	 * The displayed name of the device. Human readable.
	 */
	displayName: string;
	/**
	 * Information about the device's capabilities.
	 */
	capabilities: {
		/**
		 * Whether or not the device is wireless/can be charged.
		 * Used for determining if the device should show up in the device list.
		 */
		hasBatteryStatus: boolean;
	};
};

/**
 * The specific Streamdeck contextual instance.
 * Ie, which 'button' is being updated.
 */
export type Instance = {
	/**
	 * The device assigned to this instance.
	 * Set through the menu dropdown.
	 */
	deviceId: string;
	/**
	 * Custom title, if any.
	 * Set through the menu.
	 */
	name: string;
	/**
	 * The current charged percentage of the device.
	 */
	percentage: number;
	/**
	 * Whether or not the device is plugged in/charging.
	 */
	charging: boolean;

	/**
	 * Hexadecimal string for the icon's background color.
	 */
	backgroundColor: string;
};
