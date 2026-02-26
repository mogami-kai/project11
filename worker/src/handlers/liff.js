export function renderRegisterLiffHtml(env) {
  const registerUrl = String(env.LIFF_REGISTER_URL || '').trim();
  const escapedUrl = registerUrl.replace(/"/g, '&quot;');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Register</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; background:#f6f7f9; color:#111; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 24px; }
    .card { background:#fff; border-radius: 14px; padding: 18px; box-shadow: 0 6px 20px rgba(0,0,0,.06); }
    a.btn { display:inline-block; margin-top: 12px; padding: 10px 14px; border-radius: 10px; text-decoration: none; background:#111; color:#fff; }
    .hint { color:#666; font-size: 12px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2 style="margin:0 0 8px;">初回登録</h2>
      <p class="hint">LINEから登録ページへ進んでください。</p>
      ${
        registerUrl
          ? `<a class="btn" href="${escapedUrl}">登録ページを開く</a>`
          : '<p class="hint">LIFF_REGISTER_URL が未設定です。運用担当へ連絡してください。</p>'
      }
    </div>
  </div>
</body>
</html>`;
}

export function renderStatusPageHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Traffic v1 - Status</title>
  <style>
    body { font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; margin: 0; background:#f6f7f9; color:#111; }
    .wrap { max-width: 920px; margin: 0 auto; padding: 20px; }
    .card { background:#fff; border-radius: 14px; padding: 16px; box-shadow: 0 6px 20px rgba(0,0,0,.06); margin-bottom: 14px; }
    label { display:block; font-size: 12px; color:#444; margin: 10px 0 6px; }
    input { width:100%; padding: 10px 12px; border: 1px solid #d6dae1; border-radius: 10px; font-size: 14px; }
    button { padding: 10px 14px; border: 0; border-radius: 10px; background:#111; color:#fff; cursor:pointer; font-size: 14px; }
    button.secondary { background:#e9ecf1; color:#111; }
    .row { display:flex; gap: 12px; flex-wrap: wrap; }
    .col { flex: 1 1 220px; }
    pre { background:#0b1020; color:#d7e1ff; padding: 12px; border-radius: 12px; overflow:auto; }
    .hint { font-size:12px; color:#666; line-height:1.6; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h2 style="margin:0 0 6px;">Traffic v1 / Status</h2>
      <div class="hint">x-api-key を入力して \`/api/status\` を確認します。</div>
    </div>

    <div class="card">
      <div class="row">
        <div class="col">
          <label>API Base（空なら同一オリジン）</label>
          <input id="base" placeholder="例: https://traffic-worker-v0...workers.dev" />
        </div>
        <div class="col">
          <label>x-api-key</label>
          <input id="apikey" placeholder="WORKER_API_KEY" />
        </div>
      </div>

      <div class="row">
        <div class="col">
          <label>userId</label>
          <input id="userId" placeholder="U_TEST" />
        </div>
        <div class="col">
          <label>month (YYYY-MM)</label>
          <input id="month" placeholder="2026-02" />
        </div>
      </div>

      <div style="display:flex; gap:10px; margin-top: 12px;">
        <button id="btnSave" class="secondary">設定を保存</button>
        <button id="btnStatus">/api/status を叩く</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 10px;">Response</h3>
      <pre id="out">{}</pre>
    </div>
  </div>

<script>
  const $ = (id) => document.getElementById(id);

  function load() {
    $("base").value = localStorage.getItem("t_base") || "";
    $("apikey").value = localStorage.getItem("t_key") || "";
    $("userId").value = localStorage.getItem("t_uid") || "U_TEST";
    $("month").value = localStorage.getItem("t_month") || "2026-02";
  }

  function save() {
    localStorage.setItem("t_base", $("base").value.trim());
    localStorage.setItem("t_key", $("apikey").value.trim());
    localStorage.setItem("t_uid", $("userId").value.trim());
    localStorage.setItem("t_month", $("month").value.trim());
  }

  function apiBase() {
    const b = $("base").value.trim();
    return b ? b.replace(/\/$/, "") : "";
  }

  async function callStatus() {
    const base = apiBase();
    const userId = $("userId").value.trim();
    const month = $("month").value.trim();
    const key = $("apikey").value.trim();

    $("out").textContent = "loading...";

    const url = (base || "") + "/api/status?userId=" + encodeURIComponent(userId) + "&month=" + encodeURIComponent(month);

    const headers = {};
    if (key) headers["x-api-key"] = key;

    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    $("out").textContent = JSON.stringify({ httpStatus: res.status, body }, null, 2);
  }

  $("btnSave").addEventListener("click", save);
  $("btnStatus").addEventListener("click", callStatus);

  load();
</script>
</body>
</html>`;
}

export function renderTrafficLiffHtml(env) {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Traffic v1</title>
  <script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
</head>
<body>
  <h2>交通費申請（Worker配信ページ）</h2>
  <p>本番運用は <code>liff/index.html</code> を静的配信してください。</p>
  <button id="submit">テスト送信</button>

  <script>
    async function main() {
      await liff.init({ liffId: "${String(env.LIFF_ID || '').replace(/"/g, '\\"')}" });
      if (!liff.isLoggedIn()) {
        liff.login();
        return;
      }

      const profile = await liff.getProfile();
      const idToken = liff.getIDToken();

      document.getElementById('submit').addEventListener('click', async () => {
        const res = await fetch('/api/traffic/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: 'Bearer ' + idToken } : {})
          },
          body: JSON.stringify({
            userId: profile.userId,
            workDate: new Date().toISOString().slice(0, 10),
            project: 'P_TEST',
            name: 'テスト',
            fromStation: '東京',
            toStation: '新宿',
            amount: 200,
            roundTrip: '片道',
            submitMethod: 'normal',
            memo: 'worker-hosted-liff'
          })
        });

        const data = await res.json();
        alert(JSON.stringify(data));
      });
    }

    main().catch((e) => {
      alert('LIFF初期化エラー: ' + String(e && e.message ? e.message : e));
    });
  </script>
</body>
</html>`;
}
