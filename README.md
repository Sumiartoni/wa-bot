# 🤖 WhatsApp AI Bot + Admin Dashboard

Bot WhatsApp otomatis dengan AI (GROQ) dan dashboard admin web.

## Fitur
- ✅ Integrasi WhatsApp via Baileys
- ✅ Auto-reply dengan AI (GROQ - Llama 3.3)
- ✅ Dashboard admin dark mode
- ✅ Simpan chat ke SQLite
- ✅ Balas chat manual dari dashboard
- ✅ Toggle AI ON/OFF (global & per-user)
- ✅ Daftar user & riwayat chat
- ✅ Login admin dengan JWT
- ✅ QR Code scan dari dashboard
- ✅ Real-time status update

## Struktur Folder
```
wa-bot/
├── backend/
│   ├── server.js      # Express server + API
│   ├── bot.js         # WhatsApp Baileys bot
│   ├── database.js    # SQLite database
│   ├── groq.js        # GROQ AI integration
│   └── auth.js        # JWT authentication
├── frontend/
│   └── index.html     # Dashboard UI
├── data/              # (auto-generated) DB & auth
├── .env               # Environment variables
├── .env.example       # Contoh environment
├── package.json
└── README.md
```

## Install & Setup

### 1. Clone & Install
```bash
git clone <repo-url>
cd wa-bot
npm install
```

### 2. Konfigurasi .env
```bash
cp .env.example .env
nano .env
```
Isi `GROQ_API_KEY` dengan API key dari https://console.groq.com

### 3. Jalankan
```bash
# Development
npm run dev

# Production
npm start
```

### 4. Akses Dashboard
Buka `http://localhost:3000` → Login dengan `admin` / `admin123`

### 5. Hubungkan WhatsApp
Scan QR code yang muncul di dashboard menggunakan WhatsApp.

## Deploy di VPS

### 1. Setup VPS (Ubuntu)
```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install build tools (untuk better-sqlite3)
sudo apt install -y build-essential python3
```

### 2. Clone & Setup
```bash
cd /opt
git clone <repo-url> wa-bot
cd wa-bot
npm install --production
cp .env.example .env
nano .env  # Isi API key
```

### 3. Jalankan dengan PM2
```bash
sudo npm install -g pm2
pm2 start backend/server.js --name wa-bot
pm2 save
pm2 startup
```

### 4. Reverse Proxy (Nginx)
```nginx
server {
    listen 80;
    server_name bot.domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/wa-bot /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. SSL (Optional)
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d bot.domain.com
```

## API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| POST | `/api/auth/login` | Login admin |
| GET | `/api/auth/verify` | Verifikasi token |
| GET | `/api/bot/status` | Status bot WA |
| POST | `/api/bot/start` | Start bot |
| POST | `/api/bot/logout` | Logout WA |
| GET | `/api/chats` | Daftar chat/user |
| GET | `/api/chats/search?q=` | Cari user |
| GET | `/api/chats/:jid/messages` | Riwayat pesan |
| POST | `/api/chats/:jid/send` | Kirim pesan manual |
| GET | `/api/users` | Daftar users |
| PUT | `/api/users/:jid/ai` | Toggle AI per-user |
| GET | `/api/settings` | Get settings |
| PUT | `/api/settings` | Update settings |
| GET | `/api/stats` | Statistik dashboard |

## License
MIT
