// Test environment setup — prevents dotenv from loading real .env
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.DISCORD_BOT_TOKEN = 'test-token';
process.env.DISCORD_ZERO_ID = 'test-zero-id';

// Suppress console.log in tests to keep output clean
jest.spyOn(console, 'log').mockImplementation(() => {});
