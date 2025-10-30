#!/usr/bin/env node

/**
 * Test script to publish sample events to MQTT broker
 * Usage: node scripts/test-publish.js
 */

const mqtt = require('mqtt');

const BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const DEVICES = ['device_001', 'device_002', 'device_003'];

const client = mqtt.connect(BROKER_URL, {
  clientId: `test_publisher_${Math.random().toString(16).slice(3)}`,
});

client.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
  console.log('📤 Publishing test messages...\n');

  // Publish test messages
  publishTestMessages();

  // Publish random messages every 5 seconds
  setInterval(() => {
    publishRandomMessage();
  }, 5000);
});

client.on('error', (error) => {
  console.error('❌ MQTT Error:', error);
  process.exit(1);
});

function publishTestMessages() {
  const eventTypes = ['temperature', 'humidity', 'motion', 'door_open', 'alarm'];

  DEVICES.forEach((deviceId, index) => {
    setTimeout(() => {
      const event = {
        device_id: deviceId,
        timestamp: new Date().toISOString(),
        event_type: eventTypes[index % eventTypes.length],
        data: generateRandomData(eventTypes[index % eventTypes.length]),
        metadata: {
          location: `zone_${index + 1}`,
          firmware_version: 'v1.2.3',
        },
      };

      const topic = `edge/${deviceId}/events`;
      client.publish(topic, JSON.stringify(event), { qos: 1 }, (err) => {
        if (err) {
          console.error(`❌ Failed to publish to ${topic}:`, err);
        } else {
          console.log(`✅ Published to ${topic}:`, JSON.stringify(event, null, 2));
        }
      });
    }, index * 1000);
  });
}

function publishRandomMessage() {
  const deviceId = DEVICES[Math.floor(Math.random() * DEVICES.length)];
  const eventTypes = ['temperature', 'humidity', 'motion', 'door_open', 'alarm'];
  const eventType = eventTypes[Math.floor(Math.random() * eventTypes.length)];

  const event = {
    device_id: deviceId,
    timestamp: new Date().toISOString(),
    event_type: eventType,
    data: generateRandomData(eventType),
    metadata: {
      location: `zone_${Math.floor(Math.random() * 5) + 1}`,
      firmware_version: 'v1.2.3',
    },
  };

  const topic = `edge/${deviceId}/events`;
  client.publish(topic, JSON.stringify(event), { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ Failed to publish to ${topic}:`, err);
    } else {
      console.log(`📤 ${new Date().toISOString()} - ${deviceId} - ${eventType}`);
    }
  });
}

function generateRandomData(eventType) {
  switch (eventType) {
    case 'temperature':
      return {
        value: (Math.random() * 15 + 20).toFixed(2),
        unit: 'celsius',
      };
    case 'humidity':
      return {
        value: (Math.random() * 40 + 40).toFixed(2),
        unit: 'percent',
      };
    case 'motion':
      return {
        detected: Math.random() > 0.5,
        confidence: (Math.random() * 30 + 70).toFixed(2),
      };
    case 'door_open':
      return {
        open: Math.random() > 0.5,
        duration: Math.floor(Math.random() * 300),
      };
    case 'alarm':
      return {
        triggered: Math.random() > 0.8,
        type: ['fire', 'intrusion', 'system'][Math.floor(Math.random() * 3)],
      };
    default:
      return {
        value: Math.random() * 100,
      };
  }
}

// Handle exit
process.on('SIGINT', () => {
  console.log('\n👋 Closing connection...');
  client.end();
  process.exit(0);
});
