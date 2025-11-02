import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: '*' })); // simple pour démarrer

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const USE_RESPONSES_API = true;

// Base de connaissances en mémoire (démo)
const KB = Object.create(null);
const ensureBot = (botId) => {
  if (!KB[botId]) {
    KB[botId] = {
      instructions: "Tu es l’assistant de l’entreprise. Réponds UNIQUEMENT à partir des données ci-dessous. Si l’info n’existe pas, dis: “Je ne sais pas.”",
      docs: []
    };
  }
};
const cleanText = (t = "") => t.replace(/\s+/g, " ").replace(/<[^>]+>/g, " ").trim();

const topSnippets = (botId, question, maxChars = 4000) => {
  const q = cleanText(question).toLowerCase();
  const words = q.split(/\W+/).filter(w => w.length > 2);
  const scores = KB[botId].docs.map((d, i) => {
    const text = d.text.toLowerCase(); let s = 0;
    for (const w of words) if (text.includes(w)) s++;
    return { i, s };
  }).sort((a,b)=>b.s-a.s);

  let picked=[], total=0;
  for (const x of scores) {
    const doc = KB[botId].docs[x.i];
    if (x.s===0 && picked.length) break;
    if (total + doc.text.length <= maxChars) { picked.push(doc); total += doc.text.length; } else break;
  }
  if (!picked.length && KB[botId].docs.length) picked=[KB[botId].docs[0]];
  return picked;
};
const buildContext = (bot) =>
  bot.docs.map((d,i)=>`### Source ${i+1}${d.source?` (${d.source})`:''}\n${d.text}`).join("\n\n") || "(aucune donnée fournie)";

// Endpoints KB
app.post('/kb/set-instructions', (req,res)=>{
  const { botId, instructions } = req.body;
  if(!botId||!instructions) return res.status(400).json({error:'botId et instructions requis'});
  ensureBot(botId);
  KB[botId].instructions = String(instructions).trim();
  res.json({ ok:true });
});
app.post('/kb/add-text', (req,res)=>{
  const { botId, text, source } = req.body;
  if(!botId||!text) return res.status(400).json({error:'botId et text requis'});
  ensureBot(botId);
  KB[botId].docs.push({ text: cleanText(text), source: source||'manuel', ts: Date.now() });
  res.json({ ok:true, count: KB[botId].docs.length });
});
app.post('/kb/add-url', async (req,res)=>{
  try{
    const { botId, url } = req.body;
    if(!botId||!url) return res.status(400).json({error:'botId et url requis'});
    ensureBot(botId);
    const r = await fetch(url);
    const html = await r.text();
    const text = cleanText(html);
    KB[botId].docs.push({ text, source:url, ts:Date.now() });
    res.json({ ok:true, count: KB[botId].docs.length });
  }catch(e){
    res.status(500).json({ error:'Impossible de récupérer cette URL' });
  }
});

// Chat (Responses API)
app.post('/chat', async (req,res)=>{
  try{
    const { botId, message, conversationId } = req.body;
    if(!botId||!message) return res.status(400).json({error:'botId et message requis'});
    ensureBot(botId);

    const context = buildContext(KB[botId]);
    const systemRule = `
RÈGLES:
- Réponds UNIQUEMENT à partir des "Données de l'entreprise" ci-dessous.
- Si l'info manque: "Je ne sais pas, cette information n'est pas disponible."
- Réponses courtes et factuelles.

Données de l'entreprise:
${context}
`.trim();

    let replyText = '';

    if (USE_RESPONSES_API) {
      const response = await client.responses.create({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: KB[botId].instructions },
          { role: "system", content: systemRule },
          { role: "user", content: message }
        ],
        conversation: conversationId ? { id: conversationId } : undefined
      });

      if (response.output_text) {
        replyText = response.output_text;
      } else {
        try {
          replyText = response.output[0].content[0].text ?? '(pas de réponse)';
        } catch {
          replyText = '(pas de réponse)';
        }
      }
      return res.json({ reply: replyText, conversationId: response.id || conversationId || null });
    }

    // Fallback (au cas où)
    const cc = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: KB[botId].instructions },
        { role: "system", content: systemRule },
        { role: "user", content: message }
      ],
      temperature: 0
    });
    replyText = cc.choices?.[0]?.message?.content ?? '(pas de réponse)';
    res.json({ reply: replyText, conversationId: null });
  }catch(e){
    console.error(e);
    res.status(500).json({ error:'server error' });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, ()=>{ console.log(`API :${port}`); });
