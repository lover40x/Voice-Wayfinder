// Understanding a spoken reply before the bridge acts on it: did the person
// answer the question, ask to hear it again, ask something back, or was it
// noise? A small text model reads the question, its card and the transcript.
// Claude still makes every decision; this only keeps a round from moving on
// over a cough, a flush, or a misheard word.

/** `keep` and `change` answer a read-back of an earlier answer (`review`). */
export type UnderstandingKind = 'answer' | 'unclear' | 'repeat' | 'question' | 'comment' | 'correction' | 'keep' | 'change'

export type Understanding = {
  kind: UnderstandingKind
  /** The answer in a few words, mapped to the card's choice when it names one ("2. withdrawn", "ใช่"). */
  answer: string
  /** A short Thai confirmation spoken before the next question ("ข้อสองนะคะ"); empty for none. */
  echo: string
}

export type UnderstandRequest = {
  question: string
  /** In a round, which question this is: picks its section of the round's card. */
  questionNo?: number
  /** The question card (Markdown with numbered choices), when there is one. */
  card?: string
  /** What speech recognition heard (Thai, English terms mixed in, may be misheard). */
  heard: string
  /** The question answered just before this one, and how its answer was understood (and confirmed aloud). */
  previous?: { question: string; answer: string }
  /** They spoke over this question this many ms into it (often a reaction to the last confirmation). */
  cutInAfterMs?: number
  /** Reading back an earlier answer and asking whether to keep it: `question` is that question, `review.answer` the answer given. */
  review?: { answer: string }
}

export const INSTRUCTIONS = `You check a spoken reply in a Thai voice conversation before the conversation moves on.
You get the question that was asked aloud, its on-screen card (numbered choices, a recommendation) when there is one, and what Thai speech recognition heard. Recognition often mishears short words: "ใช่" can come out as "ไทย", "ไฉ่", "ให้" or "ไฮ"; numbers and English terms can be garbled. Noise (a cough, water, a door, other people talking) can come out as random Thai words.

Classify the reply:
- "answer": it answers the question: a choice by number or words ("ข้อสอง", "อันแรก", "2"), yes or no to a yes/no question or to the recommendation ("ใช่", "ได้", "โอเค", "ไม่"), or a free answer that fits the question. A likely mishearing of a short yes counts as yes only when the question is a yes/no question.
- "repeat": they ask to hear the question again or did not catch it ("ฟังไม่ทัน", "อะไรนะ", "อีกที"). Saying NOT to repeat ("ไม่ต้องถามใหม่") is not this.
- "question": they ask something back or want an explanation before answering ("หมายถึงอะไร", "ไม่ค่อยเข้าใจ").
- "comment": they say something on another subject, change the plan, or complain.
- "unclear": noise, words unrelated to the question, or too garbled to tell what they meant.
- "correction": they say the previous answer was heard wrong or want to change it ("เมื่อกี้บอกว่าใช่", "ฟังผิด", "ย้อนกลับไปข้อที่แล้ว", "ข้อที่แล้วไม่ใช่"). Most likely when they cut in right at the start of this question, just after hearing how their last answer was understood, and what they say contradicts it.

Yes and no: "ใช่", "ได้", "โอเค", "ถูก", "เอา" and a likely mishearing of "ใช่" are yes; "ไม่", "ไม่ใช่", "ไม่เอา" are no. Yes always agrees with the question exactly as it was asked, including any negative words inside it: to "แทนที่เลยโดยไม่ถาม Jev ใช่ไหมคะ", "ใช่" means replace without asking Jev. Never turn a yes into a no. Extra words after a yes ("ใช่ ไม่ต้องถามใหม่", "ได้ ไม่ต้องทวน") keep it a yes.

answer: for "answer", the answer in a few words: "yes" or "no" for a yes/no question, the choice number first for a choice ("2. withdrawn"), else the gist; for "question" or "comment", what they said in a few words; else "".
echo: for "answer", a very short polite Thai confirmation of what you understood, 2 to 6 words: "ใช่ค่ะ" or "ได้ค่ะ" for yes, "ไม่ใช่นะคะ" for no, "ข้อสองนะคะ" for a choice, "ใช้ withdrawn นะคะ" for a free answer; else "".`

export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'answer', 'echo'],
  properties: {
    kind: { type: 'string', enum: ['answer', 'unclear', 'repeat', 'question', 'comment', 'correction'] },
    answer: { type: 'string' },
    echo: { type: 'string' },
  },
} as const

// What Thai recognition makes of a lone "ใช่" (seen in live logs): read as
// "ใช่" before the model sees it, which otherwise guesses either way.
const MISHEARD_YES = /^(ไทย|ไท|ไฮ|ไฉ่|ใฉ่|ฉ่าย|ชัย|ไช|ไช่|ใช้)(ค่ะ|คะ|ครับ|จ้ะ|จ้า)?[.!]?$/

// "ใช้ได้" heard as "เชื่อได้", "ใครได้" or "ให้ได้" (live logs), at the start of a reply to "…ใช้ได้ไหมคะ".
const MISHEARD_USABLE = /^((?:บอกว่า|คิดว่า|ก็)?\s*)(?:เชื่อได้|ใครได้|ให้ได้|ไช้ได้)/

/**
 * A lone word recognition is known to make of "ใช่" becomes "ใช่", and a
 * "เชื่อได้"/"ใครได้"/"ให้ได้" opening a reply to "ใช้ได้ไหม" becomes "ใช้ได้";
 * anything else is kept as heard.
 */
export function normaliseHeard(heard: string, question = ''): string {
  const t = heard.trim()
  if (MISHEARD_YES.test(t)) return 'ใช่'
  return /ใช้ได้ไหม/.test(question) ? t.replace(MISHEARD_USABLE, '$1ใช้ได้') : t
}

export function userMessage(r: UnderstandRequest): string {
  return [
    ...(r.previous ? [`Previous question: ${r.previous.question}\nIts answer was understood (and confirmed aloud) as: ${r.previous.answer}`] : []),
    `Question asked: ${r.question}`,
    r.card ? `On-screen card:\n${r.card}` : 'No on-screen card.',
    ...(r.cutInAfterMs !== undefined ? [`They spoke over this question ${(r.cutInAfterMs / 1000).toFixed(1)} s after it began.`] : []),
    `Heard: ${normaliseHeard(r.heard, r.question)}`,
  ].join('\n\n')
}

/** Reads the model's JSON; undefined when it is not the shape asked for. */
export function parseUnderstanding(text: string): Understanding | undefined {
  try {
    const v = JSON.parse(text) as Partial<Understanding>
    const kinds: UnderstandingKind[] = ['answer', 'unclear', 'repeat', 'question', 'comment', 'correction']
    if (!v || typeof v !== 'object' || !kinds.includes(v.kind as UnderstandingKind)) return undefined
    return { kind: v.kind as UnderstandingKind, answer: typeof v.answer === 'string' ? v.answer : '', echo: typeof v.echo === 'string' ? v.echo.slice(0, 80) : '' }
  } catch {
    return undefined
  }
}

// ---- OpenAI Decisions API (gpt-6-luna) ---------------------------------------
// Typed answers only, no text: the reply's kind, and which numbered choice on
// the card it picks. Confirmations come from fixed phrases (ECHO), rendered
// once as clips, so they play instantly.

const THAI_NUMBERS = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า', 'สิบ']

/** Fixed spoken phrases for what was understood; each is a ready clip. */
export const ECHO = {
  yes: 'ใช่ค่ะ',
  no: 'ไม่ใช่นะคะ',
  choice: (n: number) => (n >= 1 && n <= 10 ? `ข้อ${THAI_NUMBERS[n]}นะคะ` : 'ค่ะ'),
  /** Noise or garbled words: asked once more, without reading the question again. */
  unclear: 'ขอโทษค่ะ ได้ยินไม่ชัด พูดอีกทีได้ไหมคะ',
  /** They say the last answer was misheard: the round goes back to it. */
  correction: 'เมื่อกี้น่าจะฟังผิดค่ะ งั้นเรากลับไปข้อก่อนหน้าอีกครั้งนะคะ',
  /** Read back an earlier answer, they keep it. */
  keep: 'ได้ค่ะ คงคำตอบเดิมนะคะ',
  /** They want to change it: the question follows. */
  change: 'ได้ค่ะ งั้นถามใหม่นะคะ',
} as const

/** Every fixed phrase, rendered as clips when voice connects. */
export const ECHO_CLIPS: readonly string[] = [ECHO.yes, ECHO.no, ECHO.unclear, ECHO.correction, ECHO.keep, ECHO.change, ...Array.from({ length: 8 }, (_, i) => ECHO.choice(i + 1))]

const KINDS = [
  ['yes', 'Yes: agrees with the question exactly as it was asked (ใช่, ได้, โอเค, ถูก, เอา), even with extra words after it ("ใช่ ไม่ต้องถามใหม่"). Negative words inside the question ("โดยไม่ถาม Jev") do not flip it.'],
  ['no', 'No: disagrees (ไม่, ไม่ใช่, ไม่เอา).'],
  ['choice', 'Picks one of the numbered choices on the card, by number or by its words (ข้อสอง, อันแรก, 2).'],
  ['free_answer', 'Another answer that fits the question.'],
  ['repeat', 'Asks to hear the question again or did not catch it (ฟังไม่ทัน, อะไรนะ, อีกที). Saying NOT to repeat is not this.'],
  ['question', 'Asks something back or wants an explanation before answering (หมายถึงอะไร, ไม่ค่อยเข้าใจ).'],
  ['comment', 'Talks about something else, changes the plan, or complains.'],
  ['unclear', 'Noise, words unrelated to the question, or too garbled to tell what they meant (recognition turns noise into random Thai words).'],
  [
    'correction',
    'Says the PREVIOUS answer was heard wrong or wants to change it (เมื่อกี้บอกว่าใช่, ฟังผิด, ย้อนกลับไปข้อที่แล้ว, ข้อที่แล้วไม่ใช่). Most likely when they cut in right at the start of this question, just after hearing how their last answer was understood, and what they say contradicts it.',
  ],
] as const

/**
 * The numbered choices of the question being asked, from its card. A round's
 * card holds every question (Q1, Q2, …), each numbering its own choices: only
 * the section for `questionNo` counts.
 */
export function cardChoices(card: string | undefined, questionNo?: number): { value: string; description: string }[] {
  if (!card) return []
  let section = card
  if (questionNo !== undefined) {
    const parts = card.split(/(?=\bQ\d+\b)/)
    section = parts.find(p => new RegExp(`^Q${questionNo}\\b`).test(p)) ?? (parts.length > 1 ? '' : card)
  }
  const seen = new Set<string>()
  const out: { value: string; description: string }[] = []
  for (const m of section.matchAll(/^\s*(?:[-*]\s*)?\**(\d{1,2})[.)]\**\s+(.+)$/gm)) {
    if (seen.has(m[1]!)) continue
    seen.add(m[1]!)
    out.push({ value: m[1]!, description: m[2]!.trim().slice(0, 300) })
  }
  return out
}

const REVIEW_KINDS = [
  ['keep', 'Keeps the earlier answer: เหมือนเดิม, ไม่เปลี่ยน, คงเดิม, อันเดิม, or "no" (ไม่, ไม่ต้อง) to "will you change it?".'],
  ['change', 'Wants to change it without saying the new answer yet: เปลี่ยน, ขอแก้, or "yes" (ใช่, ได้, เอา) to "will you change it?".'],
  ['new_answer', 'Gives a different answer straight away: a choice number, the other option, or new words for the question.'],
  ['question', 'Asks something back first.'],
  ['unclear', 'Noise, unrelated words, or too garbled to tell.'],
] as const

export function decisionsRequest(model: string, r: UnderstandRequest & { questionNo?: number }) {
  const choices = cardChoices(r.card, r.questionNo)
  if (r.review) {
    const questions: unknown[] = [
      {
        type: 'choice',
        name: 'kind',
        instructions:
          'In a Thai voice conversation, the earlier answer to the question below was read back to the person, and they were asked whether they want to change it. Thai speech recognition heard their reply. What do they want?',
        choices: REVIEW_KINDS.map(([value, description]) => ({ value, description })),
      },
    ]
    if (choices.length >= 2) {
      questions.push({
        type: 'choice',
        name: 'which',
        instructions: 'If they give a new answer that is one of the numbered choices on the card, which is it?',
        choices: [...choices, { value: 'none', description: 'None of them.' }],
      })
    }
    const input = [`Question: ${r.question}`, r.card ? `On-screen card:\n${r.card}` : 'No on-screen card.', `Their earlier answer: ${r.review.answer}`, `Heard now: ${normaliseHeard(r.heard, r.question)}`].join('\n\n')
    return { model, input, questions }
  }
  const questions: unknown[] = [
    {
      type: 'choice',
      name: 'kind',
      instructions:
        'A Thai voice conversation asked the question below aloud, and Thai speech recognition heard the reply. Recognition often mishears short words and turns noise into random words. What kind of reply is it?',
      choices: KINDS.map(([value, description]) => ({ value, description })),
    },
  ]
  if (choices.length >= 2) {
    questions.push({
      type: 'choice',
      name: 'which',
      instructions: 'If the reply picks one of the numbered choices on the card, or says yes to the recommended one, which is it?',
      choices: [...choices, { value: 'none', description: 'It picks none of them.' }],
    })
  }
  return { model, input: userMessage(r), questions }
}

export type DecisionAnswer = {
  type: string
  name?: string | null
  choice?: string | boolean
  confidence?: number
  probabilities?: readonly { value: string | boolean; probability: number }[]
}

/**
 * Below this confidence an "answer" is taken as noise: in live tests real
 * answers came back at 0.68 or more, noise and talk to someone else at
 * 0.12–0.25, spread over several kinds.
 */
export const MIN_ANSWER_CONFIDENCE = 0.4

/**
 * ...unless the answer kinds together are this likely. "ใช้ได้ แต่ว่า…" splits
 * between yes and free_answer (0.50 / 0.36), so neither is sure, yet it is
 * plainly an answer (0.64–0.94 together in live tests with the round's card);
 * noise and talk to someone else summed to 0.21–0.53.
 */
export const MIN_ANSWER_MASS = 0.6
/** The answer-mass rule only counts for replies at least this long (letters, spaces aside). */
const MIN_MASS_CHARS = 15
const ANSWER_KINDS = new Set(['yes', 'no', 'choice', 'free_answer'])

/** How likely the reply is an answer of any kind, when the model gave its probabilities. */
function answerMass(k: DecisionAnswer | undefined): number | undefined {
  if (!k?.probabilities?.length) return undefined
  return k.probabilities.reduce((sum, p) => (typeof p.value === 'string' && ANSWER_KINDS.has(p.value) ? sum + p.probability : sum), 0)
}

/**
 * A reply this long (letters, spaces aside) is never noise: noise comes out as
 * a few random words, but a long reply is someone explaining, even when
 * recognition garbled parts of it. It goes to Claude as said, who has the
 * context to read it.
 */
export const LONG_REPLY_CHARS = 50
const isLong = (heard: string) => heard.replace(/\s/g, '').length >= LONG_REPLY_CHARS

/**
 * Asking to hear the question again, through recognition's mishearings of
 * "ทวน" ("หวานคำถามขอห้ามหน่อย", "บนคำถามข้อห้าใหม่ให้น้อง", seen live).
 */
const QUESTION_AGAIN = /คำถาม\S{0,10}?(ใหม่|อีก|หน่อย)|ทวน|ถามใหม่|ถามอีกที|อ่านใหม่|พูดใหม่/

/** "ใช้ได้ แต่ว่า…": a yes that sets a condition. */
const HEDGE = /แต่|แค่|ยกเว้น|เว้นแต่|นอกจาก|\bbut\b|\bexcept\b/i

/** Turns the typed answers into an Understanding, with a fixed confirmation phrase. */
export function readDecisions(
  answers: readonly DecisionAnswer[],
  r: UnderstandRequest & { questionNo?: number },
  minConfidence = MIN_ANSWER_CONFIDENCE,
): Understanding | undefined {
  const k = answers.find(a => a.name === 'kind' && a.type === 'choice')
  const kind = k?.choice
  if (typeof kind !== 'string') return undefined
  const heard = normaliseHeard(r.heard, r.question)
  const unsureKind = typeof k?.confidence === 'number' && k.confidence < minConfidence
  // Split between answer kinds counts as an answer, for a reply of some length:
  // a short noise word ("เฮ้ย", "ผิดหวังบน") can also sum high over yes and no.
  const mass = answerMass(k)
  const surelyAnswer = mass !== undefined && mass >= MIN_ANSWER_MASS && heard.replace(/\s/g, '').length >= MIN_MASS_CHARS
  const lowConfidence = unsureKind && !surelyAnswer
  if (r.review) return readReview(kind, answers, r, lowConfidence)
  const yesOrNo = YES_NO_START.test(heard)
  // "ทวนคำถาม…" misheard reads as an unsure answer: it asks for the question again.
  if ((unsureKind || kind === 'unclear') && kind !== 'repeat' && !yesOrNo && !isLong(heard) && QUESTION_AGAIN.test(heard)) return { kind: 'repeat', answer: '', echo: '' }
  // Noise reads as a low-confidence answer; a reply that opens with a plain yes or no is kept.
  const unsure = lowConfidence && !yesOrNo
  if ((unsure && ANSWER_KINDS.has(kind)) || kind === 'unclear') {
    // A long explanation with garbled parts: Claude reads it, rather than "ได้ยินไม่ชัด" again.
    if (isLong(heard)) return { kind: 'answer', answer: r.heard.trim(), echo: '' }
    return { kind: 'unclear', answer: '', echo: '' }
  }
  const which = answers.find(a => a.name === 'which' && a.type === 'choice')?.choice
  const picked = typeof which === 'string' && which !== 'none' ? cardChoices(r.card, r.questionNo).find(c => c.value === which) : undefined
  const n = picked ? Number(picked.value) : undefined
  switch (kind) {
    case 'yes':
      // A yes with a condition is not a plain "ใช่ค่ะ": keep their words, acknowledge plainly.
      if (HEDGE.test(heard)) return { kind: 'answer', answer: `yes, with a condition: ${r.heard.trim()}`, echo: '' }
      return { kind: 'answer', answer: picked ? `yes (${picked.value}. ${picked.description})` : 'yes', echo: ECHO.yes }
    case 'no':
      return { kind: 'answer', answer: 'no', echo: ECHO.no }
    case 'choice':
      return picked ? { kind: 'answer', answer: `${picked.value}. ${picked.description}`, echo: ECHO.choice(n!) } : { kind: 'answer', answer: r.heard, echo: '' }
    case 'free_answer':
      return { kind: 'answer', answer: r.heard, echo: '' }
    case 'repeat':
    case 'unclear':
      return { kind, answer: '', echo: '' }
    case 'question':
    case 'comment':
      return { kind, answer: r.heard, echo: '' }
    case 'correction':
      return r.previous ? { kind, answer: r.heard, echo: '' } : { kind: 'comment', answer: r.heard, echo: '' }
    default:
      return undefined
  }
}

// ---- rules on top of either model ---------------------------------------------

/**
 * A reply that opens with a plain yes or no is an answer however unsure the
 * model is: "ใช่", "ใช้ได้ แต่ว่า…", "คิดว่าใช้ได้", "บอกว่าไม่เอา".
 */
const YES_NO_START =
  /^(?:บอกว่า|คิดว่า|ก็)?\s*(?:ไม่ใช่|ใช้ไม่ได้|ไม่ได้|ไม่เอา|ไม่ถูก|ใช้ได้|ใช่ได้|ได้เลย|ใช่|ได้|โอเค|ok|okay|ไม่|เอา|ถูก|yes|no)(?=$|[^ก-๙]|ค่ะ|คะ|ครับ|ๆ|นะ|แต่|แค่|เลย)/i
/** Words that point back at the previous answer. */
const BACK = /เมื่อกี้|เมื่อกี๊|ข้อที่แล้ว|ข้อก่อน|ข้อเมื่อกี้|ฟังผิด|ได้ยินผิด|ย้อนกลับ|ย้อนไป|กลับไปข้อ|แก้ข้อ|แก้คำตอบ|เปลี่ยนคำตอบ|previous|go back/i
/** Spoken over the very start of a question: they cannot have heard it yet. */
const EARLY_CUT_IN_MS = 1500

/**
 * Adjusts what the model read, using what it cannot weigh well: words that
 * point back at the last answer, and a "no" cut in before the new question
 * could be heard, which is about the last confirmation, not this question.
 */
export function refineUnderstanding(u: Understanding | undefined, r: UnderstandRequest): Understanding | undefined {
  if (!r.previous) return u
  const heard = r.heard.trim()
  if (BACK.test(heard)) return { kind: 'correction', answer: heard, echo: '' }
  if (u && r.cutInAfterMs !== undefined && r.cutInAfterMs < EARLY_CUT_IN_MS) {
    if (u.kind === 'answer' && /^no\b/.test(u.answer)) return { kind: 'correction', answer: heard, echo: '' }
    // A quick "yes" agrees with the last confirmation: ask this question again.
    if (u.kind === 'answer' && /^yes\b/.test(u.answer)) return { kind: 'repeat', answer: '', echo: '' }
  }
  return u
}

/** A reply to "you answered X: change it?". A new answer goes back as an ordinary answer. */
function readReview(kind: string, answers: readonly DecisionAnswer[], r: UnderstandRequest & { questionNo?: number }, unsure: boolean): Understanding | undefined {
  const which = answers.find(a => a.name === 'which' && a.type === 'choice')?.choice
  const picked = typeof which === 'string' && which !== 'none' ? cardChoices(r.card, r.questionNo).find(c => c.value === which) : undefined
  // "เอาข้อสองแทน": a change that already names the new choice is that answer.
  const named = choiceNumber(r.heard)
  const newChoice = picked ?? (named !== undefined ? cardChoices(r.card, r.questionNo).find(c => Number(c.value) === named) : undefined)
  switch (kind) {
    case 'keep':
      return { kind, answer: '', echo: '' }
    case 'change':
      return newChoice && (named !== undefined || CHOICE_WORDS.test(r.heard))
        ? { kind: 'answer', answer: `${newChoice.value}. ${newChoice.description}`, echo: ECHO.choice(Number(newChoice.value)) }
        : { kind, answer: '', echo: '' }
    case 'new_answer': {
      if (picked) return { kind: 'answer', answer: `${picked.value}. ${picked.description}`, echo: ECHO.choice(Number(picked.value)) }
      // Noise reads as an unsure new answer: ask again.
      if (unsure && !YES_NO_START.test(r.heard.trim()) && !/เปลี่ยน|แทน/.test(r.heard)) return { kind: 'unclear', answer: '', echo: '' }
      return { kind: 'answer', answer: r.heard, echo: '' }
    }
    case 'question':
      return { kind: 'question', answer: r.heard, echo: '' }
    case 'unclear':
      return { kind: 'unclear', answer: '', echo: '' }
    default:
      return undefined
  }
}

/** Words that name a choice ("ข้อสอง", "อันแรก", "2"). */
const CHOICE_WORDS = /ข้อ\s*(หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|แรก|\d)|อัน(แรก|ที่)|\d/

/** The choice number a reply names ("ข้อสอง", "อันแรก", "ข้อ 3"), if any. */
export function choiceNumber(heard: string): number | undefined {
  const m = /ข้อ\s*(หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|แรก|\d{1,2})|อัน(แรก)/.exec(heard)
  if (!m) return undefined
  const w = m[1] ?? m[2]!
  if (w === 'แรก') return 1
  if (/^\d+$/.test(w)) return Number(w)
  const n = THAI_NUMBERS.indexOf(w)
  return n > 0 ? n : undefined
}

const KEEP = /เหมือนเดิม|ไม่เปลี่ยน|คงเดิม|อันเดิม|ตามเดิม|^ไม่(ต้อง)?(ค่ะ|ครับ)?$|\bkeep\b|\bsame\b/i
const CHANGE = /เปลี่ยน|ขอแก้|^แก้|^(ใช่|ได้|เอา)(ค่ะ|ครับ)?$|\bchange\b/i

/** Without a model (typed, or the check failed): keep or change from plain words, else undefined. */
export function reviewByWords(heard: string): Understanding | undefined {
  const t = heard.trim()
  if (KEEP.test(t)) return { kind: 'keep', answer: '', echo: '' }
  if (CHANGE.test(t)) return { kind: 'change', answer: '', echo: '' }
  return undefined
}

/** How an earlier answer is read back aloud: "ใช่", "ไม่ใช่", "ข้อสอง Linear", or their words. */
export function spokenAnswer(u: Understanding | undefined, heard: string): string {
  if (!u || u.kind !== 'answer') return heard
  const hedged = /^yes, with a condition: (.+)$/s.exec(u.answer)
  if (hedged) return hedged[1]!
  if (/^yes\b/.test(u.answer)) return 'ใช่'
  if (/^no\b/.test(u.answer)) return 'ไม่ใช่'
  const m = /^(\d{1,2})\.\s*(.*)$/.exec(u.answer)
  if (m) return `ข้อ${THAI_NUMBERS[Number(m[1])] ?? m[1]} ${m[2]}`
  return u.answer || heard
}

export function thaiNumber(n: number): string {
  return THAI_NUMBERS[n] ?? String(n)
}
