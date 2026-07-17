# おえかきあて

同じ場所に集まった家族・友人向けの、リアルタイムお絵描き当てゲームです。

- 最大10人
- 4桁の部屋コードで入室
- お題は描き手のスマホにだけ表示
- 絵は全員のスマホにリアルタイム同期
- 正解は口頭（得点なし）
- 描き手は毎回ランダム

## オンラインで遊ぶ（Render 無料）

店のPCなしで、家のスマホからURLを開いて遊べます。

### 1. Render アカウント

1. https://render.com を開く
2. **GitHub でサインアップ / ログイン**
3. リポジトリ `kjmanz/testgame` へのアクセスを許可する

### 2. サービスを作る

**方法A（かんたん）**

1. Dashboard → **New** → **Web Service**
2. `kjmanz/testgame` を選ぶ
3. 設定:
   - **Name:** `draw-guess`（任意）
   - **Language:** Node
   - **Branch:** `main`
   - **Build Command:** `npm run install:all && npm run build`
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. **Deploy** を押す

**方法B（Blueprint）**

1. Dashboard → **New** → **Blueprint**
2. `kjmanz/testgame` を選ぶ（`render.yaml` が入っています）
3. そのまま適用して Deploy

### 3. 遊ぶ

1. デプロイ完了後、Render が表示する URL（例: `https://draw-guess-xxxx.onrender.com`）を開く
2. 家族のスマホでも同じ URL を開く
3. 部屋をつくってコードを共有 → 開始

**注意（無料枠）**

- しばらくアクセスがないとスリープします
- スリープ後の最初の1回は、起動に十数秒かかることがあります
- 「読み込み中…」でも少し待てば開きます

## ローカル起動（開発用）

```bash
npm run install:all
npm run dev
```

- クライアント: http://localhost:5173 （空きがなければ 5174 など）
- サーバー: http://localhost:3001

## 遊び方

1. ランダムに選ばれた人がお題を見て描く
2. 他の人は絵を見て口頭で当てる
3. 当たったら描き手が「次へ」
4. 飽きたらホストが「終了」
