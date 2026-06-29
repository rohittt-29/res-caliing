require('dotenv').config()
const express = require('express')
const app = express()
const axios = require('axios')
const mongoose = require('mongoose')
const Groq = require('groq-sdk')
const { Deepgram } = require('@deepgram/sdk')
const twilioClient = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY)

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err))

const orderSchema = new mongoose.Schema({
  customerNumber: String,
  items: String,
  total: String,
  status: { type: String, default: 'pending' },
  source: { type: String, default: 'call' },
  createdAt: { type: Date, default: Date.now }
})

const Order = mongoose.model('Order', orderSchema)
const sessions = {}
app.get('/', (req, res) => {
  res.send('Calling Agent Server Running!')
})


app.post('/incoming-call', (req, res) => {
  console.log('Call aaya!')
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="Polly.Aditi" language="hi-IN">
        Namaste! Sharma's Kitchen mein aapka swagat hai. 
        Aap kya order karna chahte hain?
      </Say>
      <Record 
        action="/handle-recording"
        method="POST"
        maxLength="20"
        playBeep="false"
        finishOnKey="#"
      />
    </Response>`
  res.type('text/xml')
  res.send(twiml)
})

app.post('/handle-recording', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl
  const twilioUrl = recordingUrl + '.mp3'
  console.log('Recording aaya:', recordingUrl)

  try {
    const audioResponse = await axios.get(twilioUrl, {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      },
      responseType: 'arraybuffer'
    })

    const audioBuffer = Buffer.from(audioResponse.data)

    const response = await deepgram.transcription.preRecorded(
      { buffer: audioBuffer, mimetype: 'audio/mp3' },
      { model: 'nova-2', language: 'hi', smart_format: true }
    )

    const transcript = response.results.channels[0].alternatives[0].transcript
    console.log('Customer ne bola:', transcript)

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Aditi" language="hi-IN">
            Ek second rukiye.
          </Say>
          <Redirect method="POST">/handle-response?transcript=${encodeURIComponent(transcript)}</Redirect>
        </Response>`

    res.type('text/xml')
    res.send(twiml)

  } catch (err) {
    console.error('Error:', err.message)
    res.type('text/xml')
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Aditi" language="hi-IN">
            Kuch error aaya. Dobara boliye.
          </Say>
          <Record action="/handle-recording" method="POST" maxLength="20" playBeep="false" finishOnKey="#"/>
        </Response>`)
  }
})

app.post('/handle-response', async (req, res) => {
  const transcript = req.query.transcript || ''
  const callSid = req.body.CallSid || req.query.CallSid
  console.log('Processing:', transcript)
  console.log('CallSid:', callSid)
  if (!sessions[callSid]) {
    sessions[callSid] = []
  }
  // Customer ka message add karo
  sessions[callSid].push({ role: 'user', content: transcript })
  try {
    const aiReply = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
        content: `You are a friendly voice ordering assistant for Sharma's Kitchen.
Menu:
- Butter Chicken - Rs 280
- Paneer Tikka - Rs 240
- Dal Makhani - Rs 180
- Naan - Rs 40
- Rice - Rs 60
- Lassi - Rs 80

RULES:
- Detect the language customer is speaking — Hindi or English
- If customer speaks Hindi → reply in Hindi only
- If customer speaks English → reply in English only
- If customer mixes both (Hinglish) → reply in Hinglish
- This is a PHONE CALL — keep replies under 2 sentences
- No special characters or emojis
- Remember the full conversation
- When customer confirms order say exactly: ORDER_CONFIRMED Items: [items] Total: Rs [amount]
- If customer says "nahi", "no", or "confirm" after ordering — confirm the order`
        },
        ...sessions[callSid]
      ]
    })

    const botReply = aiReply.choices[0].message.content
    // Bot ka reply bhi session mein add karo
    sessions[callSid].push({ role: 'assistant', content: botReply })
    const cleanReply = botReply
      .replace(/&/g, 'aur')
      .replace(/</g, '')
      .replace(/>/g, '')
      .replace(/"/g, '')
      .replace(/'/g, '')
      .trim()

    console.log('Bot ka reply:', cleanReply)
    // Order confirm hua?
    if (botReply.includes('ORDER_CONFIRMED')) {
      // Session clear karo
      delete sessions[callSid]
      if (botReply.includes('ORDER_CONFIRMED')) {
        // Items aur total extract karo
        const itemsMatch = botReply.match(/Items:\s*(.+?)Total:/s)
        const itemsText = itemsMatch ? itemsMatch[1].trim() : 'Order'
        const totalMatch = botReply.match(/Total:\s*Rs\s*(\d+)/)
        const totalAmount = totalMatch ? totalMatch[1] : '0'

        // MongoDB mein save karo
        const newOrder = new Order({
          customerNumber: callSid,
          items: itemsText,
          total: totalAmount,
          status: 'pending',
          source: 'call'
        })
        await newOrder.save()
        console.log('Order saved to MongoDB!')

        // Session clear karo
        delete sessions[callSid]

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say voice="Polly.Aditi" language="hi-IN">
        Aapka order confirm ho gaya hai. Dhanyawad Sharma's Kitchen mein aane ke liye!
      </Say>
      <Hangup/>
    </Response>`

        res.type('text/xml')
        res.send(twiml)
        return
      }

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
            <Response>
              <Say voice="Polly.Aditi" language="hi-IN">
                Aapka order confirm ho gaya hai. Dhanyawad Sharma's Kitchen mein aane ke liye!
              </Say>
              <Hangup/>
            </Response>`

      res.type('text/xml')
      res.send(twiml)
      return
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Aditi" language="hi-IN">
            ${cleanReply}
          </Say>
          <Record
            action="/handle-recording"
            method="POST"
            maxLength="20"
            playBeep="false"
            finishOnKey="#"
          />
        </Response>`

    res.type('text/xml')
    res.send(twiml)

  } catch (err) {
    console.error('Groq error:', err.message)
    res.type('text/xml')
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Aditi" language="hi-IN">
            Kuch error aaya. Dobara boliye.
          </Say>
          <Record action="/handle-recording" method="POST" maxLength="20" playBeep="false" finishOnKey="#"/>
        </Response>`)
  }
})

app.get('/make-call', async (req, res) => {
  await twilioClient.calls.create({
    to: '+917977453422',
    from: '+14422731148',
    url: ' https://hopkins-rebel-hit-election.trycloudflare.com/incoming-call'
  })
  res.send('Call ho raha hai!')
})

app.listen(3001, () => {
  console.log('Calling agent server is running on port 3001')
})