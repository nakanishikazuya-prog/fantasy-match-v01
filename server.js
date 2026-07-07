// ファンタジーマッチVer01 - バックエンドサーバー
//
// フロントエンド(public/index.html)からのリクエストを受け取り、
// Anthropic API(Claude)を呼び出して架空対戦記事を生成する。
// APIキーはこのサーバー側の環境変数でのみ扱い、フロントエンドには一切渡さない。

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[起動エラー] 環境変数 ANTHROPIC_API_KEY が設定されていません。');
  console.error('.envファイルに ANTHROPIC_API_KEY=sk-ant-xxxx を設定するか、');
  console.error('ホスティング先の環境変数設定画面でキーを登録してください。');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- CORS設定 ----
// 本番では自分のサイトのドメインだけを許可するようにALLOWED_ORIGINSを設定すること。
// 例: ALLOWED_ORIGINS=https://your-boxing-site.com,https://www.your-boxing-site.com
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // 直接アクセス・curl等は許可
    if (allowedOrigins.length === 0) return callback(null, true); // 未設定時は全許可(開発用)
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('このオリジンからのアクセスは許可されていません: ' + origin));
  }
}));

app.use(express.json({ limit: '32kb' }));
app.use(express.static('public'));

// ---- 簡易レート制限(IPベース、メモリ内保持) ----
// 注意: サーバー再起動やスケールアウトでリセットされる簡易実装。
// 本格運用する場合はRedis等の外部ストアへの置き換えを推奨。
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '8', 10); // 1時間あたりの上限回数
const rateBuckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { windowStart: now, count: 1 });
    return next();
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再度お試しください。' });
  }
  bucket.count += 1;
  next();
}

// 古いバケットを定期的に掃除(メモリリーク防止)
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets.entries()) {
    if (now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(ip);
  }
}, 15 * 60 * 1000).unref();

// ---- 入力の丸め込み(トークン濫用・巨大入力対策) ----
function clip(str, max) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max);
}

const weightClassOrder = ["ミニマム級", "ライトフライ級", "フライ級", "スーパーフライ級", "バンタム級", "スーパーバンタム級", "フェザー級", "スーパーフェザー級", "ライト級", "スーパーライト級", "ウェルター級", "スーパーウェルター級", "ミドル級", "スーパーミドル級", "ライトヘビー級", "クルーザー級", "ヘビー級"];
const VALID_STANCES = ['', 'オーソドックス', 'サウスポー'];
const VALID_ROUNDS = ['4', '6', '8', '10', '12'];

// プロンプトの禁止指示だけでは生成AIが守り切れない場合があるため、
// 最終出力の前に禁止語を機械的に置き換える保険のフィルター。
function sanitizeBannedWords(text) {
  if (!text) return text;
  const replacements = [
    [/鬼畜/g, '驚異'],
    [/卑怯者/g, '強者'],
    [/屑/g, '難敵'],
    [/格下/g, '相手'],
    [/格上/g, '相手']
  ];
  let out = text;
  replacements.forEach(pair => { out = out.replace(pair[0], pair[1]); });
  return out;
}

function buildKobayashiBlock(nameA, nameB, classA, classB, diff) {
  const lines = [
    '待った待った待った!! さすがにこれは看過できません。',
    'ちょっと待ってください、これはあまりに無茶なカードです。',
    'うーん…これは今回は通せません。',
    'いやいやいや、これはさすがに危険すぎます。'
  ];
  const line = lines[Math.floor(Math.random() * lines.length)];
  return [
    '【セレス小林コミッショナー(架空)より】',
    line,
    '',
    nameA + '(' + (classA || '階級不明') + ') と ' + nameB + '(' + (classB || '階級不明') + ') の対戦は、' + diff + '階級差の無謀なミスマッチと判断されました。',
    '選手の安全を考慮し、このカードは今回は承認されませんでした。階級が近い相手を選び直してご利用ください。',
    '',
    '※これは遊び要素のジョーク演出です。実際のボクシング興行における判断ではありません。'
  ].join('\n');
}

async function callClaude(prompt) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }]
  });
  const block = res.content && res.content[0];
  return block && block.type === 'text' ? block.text.trim() : '';
}

function buildArticlePrompt(input, classRule) {
  const { nameA, nameB, classA, classB, recordA, recordB, stanceA, stanceB, reachA, reachB, eraA, eraB, styleA, styleB, rounds } = input;
  return [
    'あなたはボクシング専門メディアの実況ライター兼アナリストです。以下の2人による架空対戦(if対戦)を、可能な限り史実の戦績・スタイル・体格に基づいてリアルに考察し、記事を書いてください。',
    '',
    '【選手A】',
    '名前: ' + nameA,
    '階級: ' + (classA || '(不明)'),
    '通算戦績: ' + (recordA || '(不明)'),
    'スタンス: ' + (stanceA || '(不明)'),
    '身長・リーチ: ' + (reachA || '(不明)'),
    '時代・コンテキスト: ' + (eraA || '(指定なし。特に指定がない場合は選手の全盛期・最も脂が乗っていた時期を基準にすること)'),
    'スタイル・特徴・実績: ' + (styleA || '(指定なし)'),
    '',
    '【選手B】',
    '名前: ' + nameB,
    '階級: ' + (classB || '(不明)'),
    '通算戦績: ' + (recordB || '(不明)'),
    'スタンス: ' + (stanceB || '(不明)'),
    '身長・リーチ: ' + (reachB || '(不明)'),
    '時代・コンテキスト: ' + (eraB || '(指定なし。特に指定がない場合は選手の全盛期・最も脂が乗っていた時期を基準にすること)'),
    'スタイル・特徴・実績: ' + (styleB || '(指定なし)'),
    '',
    '【試合条件】',
    'ラウンド数: ' + rounds + '回戦',
    '',
    '執筆条件:',
    '- 冒頭で「これはAIによる架空のシミュレーション記事であり、実際の対戦・予想ではない」と明記する',
    '- 続けて「これは作成者が考える、両選手の全盛期同士の戦いを想定したシミュレーションです」という趣旨の一文を添える',
    '- 出身地・所属ジム・私生活・具体的な生年月日など、上記に入力されていない選手の経歴情報は絶対に創作しない。出身地や個人的なエピソードには一切触れず、あくまで入力された戦績・スタンス・体格・スタイルの範囲内で試合内容を描写する。不確かな固有情報を書くくらいなら書かない方がよい',
    '- 用語はボクシングで実際に使われるものだけを使う(例: パワーパンチャー、スラッガー、ボクサーファイター、インファイター、アウトボクサー、テクニシャン等)。「パワーヒッター」のような野球など他競技由来の用語をボクシングの文脈で使わない',
    '- 「ビジョン」ではなく「視界」など、自然な日本語のボクシング表現を使う。カタカナの直訳語を不用意に使わない',
    '- 両者の実際の戦績・実力・スタンス(オーソドックス/サウスポーの相性)・身長やリーチの体格差を踏まえ、論理的に説得力のある展開にする。実力差がある場合でも、絶対的な力関係だけで結果を固定せず、番狂わせも論理的に成立する範囲であり得るとする',
    classRule,
    '- 指定されたラウンド数(' + rounds + '回戦)を前提に展開を描写する。ラウンド数が短い場合(4〜6回戦)は序盤の破壊力・瞬発力・スタミナ切れの少なさが活きる展開に、長い場合(10〜12回戦)はスタミナ配分・戦術変化・終盤の逆転といった長丁場ならではの要素を反映し、同じ組み合わせでもラウンド数によって展開や結果が変わり得るようにする',
    '- 決着は次のいずれかにする。(1)KO/TKOによる決着。(2)判定に持ち込まれた場合、ジャッジ3者のスコアを必ず明記する。実力差が明確なら「3-0(ユナニマスデシジョン)」も普通の結果として使ってよい。僅差なら「2-1(スプリットデシジョン)」、1名だけイーブンスコアなら「2-0(マジョリティデシジョン)」とする。ジャッジが真っ二つに割れて決着がつかない場合のみ「引き分け(1-1、ドロー)」とする。内容(実力差・体格差・ラウンド数)に見合ったスコアにし、僅差にするために無理に結果を歪めない。(3)両者の相性(接近戦志向が強い、頭を低くして突っ込むスタイル同士など)によっては、偶発的なバッティング(頭突き)による負傷が原因で続行不可能になり、規定ラウンドまでの採点で決する「負傷判定(テクニカルデシジョン)」を選んでもよい。これは頻発させず、両者のスタイルから偶発的な接触が起こりやすいと言える場合にのみ使う',
    '- 本人が実際に発言したかのような直接的なセリフの捏造はしない。動作・攻防・展開の描写に留める',
    '- 実在の人物の名誉を貶める意図ではなく、あくまでエンターテインメントとしての架空シミュレーションであるため、勝敗の結果自体は遠慮せず説得力のある内容にしてよい',
    '- ただし選手個人の人格・人間性を否定するような侮辱的な言葉は、勝敗やトーンに関わらず絶対に使わない。「鬼畜」「屑」「卑怯者」のような、人格を貶める表現は禁止。強さを表す表現は「モンスター」「怪物」「鉄人」「無敵」など、ボクシングメディアで実際に使われる、あくまで能力を称える系統の言葉に限定する',
    '- 「格下」「格上」のようなレッテル表現は、実力差や勝敗の結果に関わらず絶対に使わない。両選手とも第一線級の実力者として対等に敬意を持って描写し、どちらか一方を低く評価するような言い回しは避ける。「牙を剥く」など攻勢に出る様子を表す動的な比喩表現自体は問題なく使ってよい。パンチを受けた際の出血・カット・ダウンなど試合展開上の身体的描写(ボクシングに当然伴う要素)も問題ない',
    '- 最後に「なぜこの結果になったのか」を戦績・スタイル・体格・ラウンド数の観点から一言添える',
    '- 文体はボクシング専門メディア風で、多少煽り気味のトーンでよい',
    '- 出力は記事本文のみ。1行目にタイトル、2行目以降に本文'
  ].join('\n');
}

function buildTeaserPrompt(article) {
  return [
    '以下の架空対戦記事を、X(旧Twitter)投稿用に140字以内で要約してください。',
    '賛否を呼ぶような煽り気味の一文にし、最後にハッシュタグを2〜3個(選手名を含む)つけてください。出力はテキストのみ。',
    '',
    '記事:',
    article
  ].join('\n');
}

function buildFactcheckPrompt(input, article) {
  const { nameA, nameB, recordA, recordB, stanceA, stanceB, reachA, reachB, eraA, eraB, styleA, styleB } = input;
  return [
    '以下の【入力データ】と【記事】を比較し、次の種類の問題を箇条書きでリストしてください。',
    '(1) 記事本文に含まれる固有の事実情報(出身地、所属ジム、生年月日、具体的な地名・日付・大会名など)のうち、【入力データ】に書かれていないもの',
    '(2) 「パワーヒッター」など、野球やサッカーなど他競技由来でボクシングでは使わない用語の誤用',
    '(3) 「鬼畜」「屑」「卑怯者」など、選手個人の人格・人間性を否定する侮辱的な表現(強さを称える「モンスター」「怪物」等は問題ない)',
    '(4) 「格下」「格上」のように一方の選手を低く評価するレッテル表現(「牙を剥く」等の攻勢を表す比喩や、出血・カット・ダウンなど試合展開上の身体描写自体は問題ない)',
    '入力データに書かれている戦績・スタンス・身長リーチ・時代背景・スタイルの範囲内の記述は問題ないので含めない。',
    '該当するものが1つもなければ「入力データにない固有情報・用語の誤用は見つかりませんでした」とだけ出力してください。',
    '出力は箇条書き(または上記の1文)のみ。前置きや解説は不要。',
    '',
    '【入力データ】',
    '選手A: ' + nameA + ' / 戦績:' + (recordA || '不明') + ' / スタンス:' + (stanceA || '不明') + ' / 体格:' + (reachA || '不明') + ' / 時代:' + (eraA || '不明') + ' / 特徴:' + (styleA || '不明'),
    '選手B: ' + nameB + ' / 戦績:' + (recordB || '不明') + ' / スタンス:' + (stanceB || '不明') + ' / 体格:' + (reachB || '不明') + ' / 時代:' + (eraB || '不明') + ' / 特徴:' + (styleB || '不明'),
    '',
    '【記事】',
    article
  ].join('\n');
}

app.post('/api/generate', rateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const input = {
      nameA: clip(body.nameA, 60),
      nameB: clip(body.nameB, 60),
      recordA: clip(body.recordA, 120),
      recordB: clip(body.recordB, 120),
      stanceA: VALID_STANCES.includes(body.stanceA) ? body.stanceA : '',
      stanceB: VALID_STANCES.includes(body.stanceB) ? body.stanceB : '',
      reachA: clip(body.reachA, 160),
      reachB: clip(body.reachB, 160),
      eraA: clip(body.eraA, 400),
      eraB: clip(body.eraB, 400),
      styleA: clip(body.styleA, 400),
      styleB: clip(body.styleB, 400),
      rounds: VALID_ROUNDS.includes(String(body.rounds)) ? String(body.rounds) : '10'
    };
    input.classA = weightClassOrder.includes(body.classA) ? body.classA : '';
    input.classB = weightClassOrder.includes(body.classB) ? body.classB : '';

    if (!input.nameA || !input.nameB) {
      return res.status(400).json({ error: '選手Aと選手Bの名前を入力してください' });
    }

    let classDiff = null;
    if (input.classA && input.classB) {
      const ia = weightClassOrder.indexOf(input.classA);
      const ib = weightClassOrder.indexOf(input.classB);
      if (ia >= 0 && ib >= 0) classDiff = Math.abs(ia - ib);
    }

    if (classDiff !== null && classDiff >= 4 && Math.random() < 0.25) {
      const blockArticle = buildKobayashiBlock(input.nameA, input.nameB, input.classA, input.classB, classDiff);
      return res.json({
        blocked: true,
        article: blockArticle,
        teaser: '(試合不成立のため投稿は控えましょう)',
        factcheck: '(判定不要:試合不成立のため)'
      });
    }

    let classRule;
    if (classDiff !== null && classDiff >= 4) {
      const ia = weightClassOrder.indexOf(input.classA);
      const ib = weightClassOrder.indexOf(input.classB);
      const heavierName = ia > ib ? input.nameA : input.nameB;
      const lighterName = heavierName === input.nameA ? input.nameB : input.nameA;
      classRule = '- 階級差が' + classDiff + '階級と非常に大きい。ボクシングは階級制のスポーツであり、これほどの体格・パワー差は技術や経験で覆せるものではない。' + heavierName + 'が終始優位に立ち、明確に(KO/TKO、または一方的な判定で)勝利する内容にすること。' + lighterName + 'が善戦する描写、僅差の判定、逆転勝利は書かない';
    } else if (classDiff !== null) {
      classRule = '- 階級差は' + classDiff + '階級。この程度の差であれば通常の実力差・番狂わせのルールに従ってよい';
    } else {
      classRule = '- 階級が不明なため、入力された戦績・体格・スタイルの情報から実力差を判断すること';
    }

    let article = await callClaude(buildArticlePrompt(input, classRule));
    article = sanitizeBannedWords(article);

    let teaser = await callClaude(buildTeaserPrompt(article));
    teaser = sanitizeBannedWords(teaser);

    const factcheck = await callClaude(buildFactcheckPrompt(input, article));

    res.json({ blocked: false, article, teaser, factcheck });
  } catch (err) {
    console.error('[生成エラー]', err);
    res.status(500).json({ error: '生成に失敗しました。しばらくしてから再度お試しください。' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, model: MODEL }));

// require.main === module のときだけ実際にサーバーを起動する。
// これによりテストコードから純粋関数だけを安全にrequireできる。
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('ファンタジーマッチVer01 サーバー起動: http://localhost:' + PORT);
    console.log('使用モデル: ' + MODEL);
  });
}

module.exports = {
  sanitizeBannedWords,
  buildKobayashiBlock,
  buildArticlePrompt,
  buildTeaserPrompt,
  buildFactcheckPrompt,
  weightClassOrder,
  clip
};
