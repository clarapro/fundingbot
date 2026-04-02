# FundingBot — Guide de déploiement Vercel

## Structure du projet
```
fundingbot/
├── api/
│   └── rates.js        ← Backend serverless (proxy exchanges)
├── src/
│   ├── main.jsx        ← Entry point React
│   └── App.jsx         ← Dashboard complet
├── index.html
├── package.json
├── vite.config.js
└── vercel.json
```

---

## Étape 1 — Prérequis

Installe Node.js si pas déjà fait : https://nodejs.org (version 18+)

Vérifie :
```bash
node --version   # doit afficher v18+ ou v20+
npm --version
```

---

## Étape 2 — Créer le projet en local

```bash
# Clone ou crée le dossier
mkdir fundingbot && cd fundingbot

# Copie tous les fichiers fournis dans ce dossier
# (api/rates.js, src/main.jsx, src/App.jsx, index.html, package.json, vite.config.js, vercel.json)

# Installe les dépendances
npm install
```

---

## Étape 3 — Tester en local

```bash
# Lance Vite (frontend)
npm run dev
```

Ouvre http://localhost:5173 — le dashboard s'affiche mais /api/rates ne marche pas encore en local.

Pour tester l'API en local, ouvre un second terminal :
```bash
npm install -g vercel
vercel dev
```
Ça lance le tout (frontend + fonctions serverless) sur http://localhost:3000

---

## Étape 4 — Créer un compte Vercel

1. Va sur https://vercel.com
2. "Sign up" → connecte ton compte **GitHub**
3. C'est gratuit, aucune carte requise

---

## Étape 5 — Pousser sur GitHub

```bash
# Dans le dossier fundingbot/
git init
git add .
git commit -m "FundingBot initial"

# Crée un repo sur github.com (bouton "New repository")
# Puis :
git remote add origin https://github.com/TON_USERNAME/fundingbot.git
git push -u origin main
```

---

## Étape 6 — Déployer sur Vercel

```bash
# Option A : depuis le terminal
npx vercel --prod

# Option B : depuis l'interface Vercel
# 1. vercel.com/dashboard → "Add New Project"
# 2. Importe ton repo GitHub "fundingbot"
# 3. Clique "Deploy"
# C'est tout.
```

Vercel détecte automatiquement Vite + les fonctions dans /api.

Ton site sera live sur : `https://fundingbot-xxx.vercel.app`

---

## Étape 7 — Vérifier que ça marche

Ouvre `https://ton-site.vercel.app/api/rates` dans le navigateur.
Tu dois voir un JSON comme :
```json
{
  "ok": true,
  "count": 342,
  "ts": 1743600000000,
  "rows": [...]
}
```

Si tu vois ça → tout fonctionne, le dashboard est live avec des données réelles.

---

## Étape 8 — Domaine personnalisé (optionnel)

Dans Vercel Dashboard → ton projet → "Domains" → ajoute `fundingbot.fr` ou autre.
Un certificat SSL est généré automatiquement (HTTPS gratuit).

---

## Notes techniques

- L'API `/api/rates` est mise en cache 30 secondes par Vercel CDN
- Le frontend refresh automatiquement toutes les 60s
- Si un exchange est down, les autres continuent de fonctionner (Promise.allSettled)
- Hyperliquid rate toutes les **1h**, Binance/Bybit/MEXC toutes les **8h**

---

## Pour automatiser les trades (étape suivante)

Ajoute `api/execute.js` avec tes clés API exchange dans les variables d'environnement Vercel :
- Vercel Dashboard → Settings → Environment Variables
- Ajoute : `BINANCE_API_KEY`, `BINANCE_SECRET`, `BYBIT_API_KEY`, etc.

**Ne mets JAMAIS tes clés API dans le code source.**
