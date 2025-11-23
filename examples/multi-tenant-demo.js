/**
 * Multi-Tenant Router Demo
 *
 * Shows how to use the new multi-tenant architecture
 */

import { startMultiTenantServer } from '../src/index.js';
import pg from 'pg';

const { Client } = pg;

async function demo() {
  console.log('🚀 Starting multi-tenant router demo...\n');

  // Start multi-tenant router
  const router = await startMultiTenantServer({
    port: 15432,
    baseDir: './demo-data',
    logLevel: 'info'
  });

  console.log('\n📊 Initial stats:');
  console.log(JSON.stringify(router.getStats(), null, 2));

  // Connect to database "user123" (auto-created)
  console.log('\n📥 Connecting to database: user123');
  const client1 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'user123'
  });

  await client1.connect();
  console.log('✅ Connected to user123');

  // Create table and insert data
  await client1.query('CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)');
  await client1.query("INSERT INTO users (name) VALUES ('Alice'), ('Bob')");

  const result1 = await client1.query('SELECT * FROM users');
  console.log('📋 user123 data:', result1.rows);

  await client1.end();
  console.log('🔌 Disconnected from user123');

  // Connect to database "app456" (auto-created)
  console.log('\n📥 Connecting to database: app456');
  const client2 = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'app456'
  });

  await client2.connect();
  console.log('✅ Connected to app456');

  // Different schema in different database
  await client2.query('CREATE TABLE posts (id SERIAL PRIMARY KEY, title TEXT)');
  await client2.query("INSERT INTO posts (title) VALUES ('Hello World'), ('Multi-tenant magic')");

  const result2 = await client2.query('SELECT * FROM posts');
  console.log('📋 app456 data:', result2.rows);

  await client2.end();
  console.log('🔌 Disconnected from app456');

  // Show final stats
  console.log('\n📊 Final stats:');
  console.log(JSON.stringify(router.getStats(), null, 2));

  console.log('\n📋 All databases:');
  console.log(JSON.stringify(router.listDatabases(), null, 2));

  // Reconnect to user123 to verify data persists
  console.log('\n🔄 Reconnecting to user123 to verify data persists...');
  const client1Again = new Client({
    host: '127.0.0.1',
    port: 15432,
    database: 'user123'
  });

  await client1Again.connect();
  const persistedData = await client1Again.query('SELECT * FROM users');
  console.log('✅ Persisted data in user123:', persistedData.rows);

  await client1Again.end();

  // Stop router
  console.log('\n🛑 Stopping router...');
  await router.stop();

  console.log('\n✅ Demo complete!');
  console.log('\n🎯 Key achievements:');
  console.log('  • Single port (15432) handled multiple databases');
  console.log('  • Auto-provisioned user123 and app456');
  console.log('  • Data isolated between databases');
  console.log('  • Data persisted across reconnections');
  console.log('  • Zero configuration required!');
}

demo().catch((error) => {
  console.error('❌ Demo failed:', error);
  process.exit(1);
});
