import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { config, ensureRuntimeDirs, paths } from "../src/config.js";

const prisma = new PrismaClient();

async function main() {
  ensureRuntimeDirs();

  const passwordHash = await bcrypt.hash(config.ADMIN_PASSWORD, 12);
  const admin = await prisma.user.upsert({
    where: { email: config.ADMIN_EMAIL },
    update: { passwordHash, name: config.ADMIN_NAME, role: "superadmin" },
    create: {
      email: config.ADMIN_EMAIL,
      passwordHash,
      name: config.ADMIN_NAME,
      role: "superadmin"
    }
  });

  await prisma.rateLimitPolicy.upsert({
    where: { scope: "global_messages" },
    update: { limit: config.MESSAGE_RATE_LIMIT_PER_MINUTE, windowSeconds: 60 },
    create: { scope: "global_messages", limit: config.MESSAGE_RATE_LIMIT_PER_MINUTE, windowSeconds: 60 }
  });
  await prisma.rateLimitPolicy.upsert({
    where: { scope: "ai_generation" },
    update: { limit: config.AI_RATE_LIMIT_PER_MINUTE, windowSeconds: 60 },
    create: { scope: "ai_generation", limit: config.AI_RATE_LIMIT_PER_MINUTE, windowSeconds: 60 }
  });
  await prisma.rateLimitPolicy.upsert({
    where: { scope: "ai_contact_daily" },
    update: { limit: config.AI_CONTACT_DAILY_LIMIT, windowSeconds: 86_400 },
    create: { scope: "ai_contact_daily", limit: config.AI_CONTACT_DAILY_LIMIT, windowSeconds: 86_400 }
  });
  await prisma.rateLimitPolicy.upsert({
    where: { scope: "ai_daily" },
    update: { limit: config.AI_DAILY_LIMIT, windowSeconds: 86_400 },
    create: { scope: "ai_daily", limit: config.AI_DAILY_LIMIT, windowSeconds: 86_400 }
  });

  const settings = {
    ai_confidence_threshold: String(config.AI_CONFIDENCE_THRESHOLD),
    ai_default_enabled: String(config.AI_DEFAULT_ENABLED),
    default_model: config.OPENROUTER_MODEL,
    backup_interval_minutes: String(config.BACKUP_INTERVAL_MINUTES),
    backup_retention_days: String(config.BACKUP_RETENTION_DAYS),
    message_queue_max_attempts: String(config.MESSAGE_QUEUE_MAX_ATTEMPTS),
    message_queue_retry_seconds: String(config.MESSAGE_QUEUE_RETRY_SECONDS),
    audit_redaction_keys: config.AUDIT_REDACTION_KEYS
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.appSetting.upsert({ where: { key }, update: {}, create: { key, value } });
  }

  await prisma.whatsappSession.upsert({
    where: { sessionName: "local" },
    update: { filePath: paths.whatsappSessions, encryptionEnabled: Boolean(config.WHATSAPP_SESSION_ENCRYPTION_KEY) },
    create: { sessionName: "local", filePath: paths.whatsappSessions, connected: false, encryptionEnabled: Boolean(config.WHATSAPP_SESSION_ENCRYPTION_KEY) }
  });

  if (config.ORDER_WEBHOOK_URL) {
    await prisma.webhookEndpoint.upsert({
      where: { name: "order_default" },
      update: { url: config.ORDER_WEBHOOK_URL, secret: config.ORDER_WEBHOOK_SECRET || null, enabled: true, maxAttempts: config.ORDER_WEBHOOK_MAX_ATTEMPTS, backoffSeconds: config.ORDER_WEBHOOK_BACKOFF_SECONDS },
      create: { name: "order_default", url: config.ORDER_WEBHOOK_URL, secret: config.ORDER_WEBHOOK_SECRET || null, enabled: true, maxAttempts: config.ORDER_WEBHOOK_MAX_ATTEMPTS, backoffSeconds: config.ORDER_WEBHOOK_BACKOFF_SECONDS }
    });
  }

  const contact = await prisma.contact.upsert({
    where: { waId: "6281234567890@s.whatsapp.net" },
    update: {},
    create: {
      waId: "6281234567890@s.whatsapp.net",
      name: "Demo Customer",
      phone: "6281234567890",
      aiEnabled: false,
      optOut: false
    }
  });

  const conversation = await prisma.conversation.upsert({
    where: { id: 1 },
    update: { contactId: contact.id },
    create: { contactId: contact.id, unreadCount: 1 }
  });

  const existingMessages = await prisma.message.count({ where: { conversationId: conversation.id } });
  if (existingMessages === 0) {
    await prisma.message.createMany({
      data: [
        {
          conversationId: conversation.id,
          from: "contact",
          content: "Halo, saya mau tanya harga joki tugas matematika kuliah.",
          generatedBy: "manual",
          status: "delivered",
          deliveredAt: new Date()
        },
        {
          conversationId: conversation.id,
          from: "system",
          content: "Demo conversation seeded for local testing. Enable AI per contact before generating suggestions.",
          generatedBy: "manual",
          status: "delivered",
          deliveredAt: new Date()
        }
      ]
    });
  }

  await prisma.template.upsert({
    where: { id: 1 },
    update: { createdBy: admin.id },
    create: {
      name: "Harga Awal",
      body: "Halo {{name}}, harga mulai Rp50.000 tergantung deadline dan tingkat kesulitan. Bisa kirim detail tugasnya?",
      tags: "pricing,first-response",
      createdBy: admin.id
    }
  });

  await prisma.template.upsert({
    where: { id: 2 },
    update: { createdBy: admin.id },
    create: {
      name: "Minta Deadline",
      body: "Boleh kirim deadline, instruksi lengkap, rubrik, dan file pendukungnya supaya admin bisa cek estimasi pengerjaan?",
      tags: "deadline,requirements,first-response",
      createdBy: admin.id
    }
  });

  await prisma.automationMacro.upsert({
    where: { id: 1 },
    update: { createdBy: admin.id },
    create: {
      name: "Auto Harga Awal",
      keywords: "harga,biaya,price",
      body: "Halo {{name}}, harga mulai Rp50.000 tergantung deadline dan tingkat kesulitan. Admin akan cek detail tugasnya dulu ya.",
      tags: "pricing,automation",
      createdBy: admin.id
    }
  });

  await prisma.knowledgeBase.upsert({
    where: { id: 1 },
    update: {},
    create: {
      title: "Pricing Basics",
      snippet: "Harga mulai Rp50.000 per tugas dan menyesuaikan deadline, tingkat kesulitan, serta jumlah halaman/soal.",
      content: "JokiTugasKu.online membantu tugas akademik dengan estimasi harga awal Rp50.000. Admin harus mengonfirmasi detail tugas, deadline, dan rubrik sebelum memberi harga final.",
      tags: "pricing,policy"
    }
  });

  await prisma.knowledgeBase.upsert({
    where: { id: 2 },
    update: {},
    create: {
      title: "Deadline Intake",
      snippet: "Admin perlu menanyakan deadline, instruksi tugas, format file, dan rubrik sebelum memberi estimasi final.",
      content: "Untuk setiap chat baru, kumpulkan deadline, mata kuliah/subjek, jumlah halaman atau soal, rubrik, file pendukung, dan format pengumpulan. Jangan menjanjikan hasil sebelum admin menilai tingkat kesulitan.",
      tags: "deadline,requirements,policy"
    }
  });

  await prisma.order.upsert({
    where: { orderRef: "DRAFT-DEMO-001" },
    update: {},
    create: {
      contactId: contact.id,
      orderRef: "DRAFT-DEMO-001",
      status: "draft",
      total: 50000,
      attributes: JSON.stringify({ subject: "Matematika", level: "Kuliah", deadline: "Belum dikonfirmasi" }),
      createdBy: admin.id
    }
  });

  await prisma.auditLog.create({
    data: {
      action: "seed_completed",
      actorId: admin.id,
      targetType: "system",
      targetId: null,
      meta: JSON.stringify({ adminEmail: admin.email })
    }
  });

  console.log(`Seeded admin ${admin.email} and demo data.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
