const fetch = require('node-fetch')

const ALPACA_KEY = process.env.ALPACA_API_KEY
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY
const FINNHUB_KEY = process.env.FINNHUB_API_KEY

async function testAlpaca() {
  try {
    const res = await fetch(
      'https://paper-api.alpaca.markets/v2/account',
      { headers: {
        'APCA-API-KEY-ID': ALPACA_KEY,
        'APCA-API-SECRET-KEY': ALPACA_SECRET
      }}
    )
    const data = await res.json()
    console.log('ALPACA STATUS:', res.status)
    console.log('ACCOUNT ID:', data.id)
    console.log('BUYING POWER:', data.buying_power)
  } catch(e) {
    console.log('ALPACA ERROR:', e.message)
  }
}

async function run() {
  console.log('PULSETRADER STARTING')
  await testAlpaca()
  setInterval(async () => {
    console.log('TICK:', new Date().toISOString())
  }, 30000)
}

run()
