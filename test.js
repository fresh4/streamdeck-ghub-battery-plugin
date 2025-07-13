import { WebSocket } from 'ws'

const devices = []

const ws = new WebSocket('ws://localhost:9010', 'json', {
    headers: {
        'origin': 'file://',
        'pragma': 'no-cache',
        'cache-control': 'no-cache',
        'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
        'sec-websocket-protocol': 'json',
    },
});

ws.on('open', () => {
    console.log("Successfully connected to Logitech G Hub.")

    // Get the device list for showing valid battery enabled devices.
    ws.send(JSON.stringify({ path: '/devices/list', verb: 'GET' }))

    // Subscribe to the battery state change event to update battery and charging status display
    ws.send(JSON.stringify({ path: '/battery/state/changed', verb: "SUBSCRIBE" }))
})

ws.on('message', msg => {
    const payload = JSON.parse(msg.toString('utf-8'))

    if (payload.path === '/devices/list') {
        payload.payload.deviceInfos.forEach(d => {
            if (d.capabilities.hasBatteryStatus) {
                devices.push(d)
            }
        });
    }

    if (payload.path === '/battery/state/changed') {
        console.log(payload.payload.percentage)
        console.log(payload.payload.charging)
    }

})