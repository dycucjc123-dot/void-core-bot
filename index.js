require("dotenv").config();

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, ChannelType
} = require("discord.js");
const Database = require("better-sqlite3");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`환경변수 ${key}가 비어 있습니다. .env 파일을 확인하세요.`);
    process.exit(1);
  }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const db = new Database(process.env.DB_PATH || "void-core.sqlite");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL CHECK(price >= 0),
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    license TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id)
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TEXT,
    delivered_license TEXT,
    FOREIGN KEY(product_id) REFERENCES products(id)
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_open_ticket_per_user
  ON tickets(guild_id, user_id) WHERE status = 'OPEN';
`);

// Upgrade an existing v1 database without deleting prior products, stock, or orders.
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(column => column.name);
if (!orderColumns.includes("delivered_license")) {
  db.exec("ALTER TABLE orders ADD COLUMN delivered_license TEXT");
}

const commands = [
  new SlashCommandBuilder().setName("shop").setDescription("VOID CORE 상품 목록을 표시합니다."),
  new SlashCommandBuilder().setName("ticket-panel").setDescription("관리자: 비공개 문의 패널을 게시합니다."),
  new SlashCommandBuilder().setName("add-product").setDescription("관리자: 상품을 등록합니다.")
    .addStringOption(o => o.setName("name").setDescription("상품명").setRequired(true))
    .addIntegerOption(o => o.setName("price").setDescription("가격 (KRW)").setRequired(true).setMinValue(0))
    .addStringOption(o => o.setName("description").setDescription("상품 설명").setRequired(false)),
  new SlashCommandBuilder().setName("add-stock").setDescription("관리자: 제품 키 재고를 추가합니다.")
    .addIntegerOption(o => o.setName("product-id").setDescription("상품 ID").setRequired(true).setMinValue(1))
    .addStringOption(o => o.setName("keys").setDescription("키를 한 줄에 하나씩 입력").setRequired(true)),
  new SlashCommandBuilder().setName("approve").setDescription("관리자: 입금 확인 후 주문을 승인하고 상품을 지급합니다.")
    .addIntegerOption(o => o.setName("order-id").setDescription("주문 ID").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("orders").setDescription("관리자: 최근 주문을 확인합니다."),
  new SlashCommandBuilder().setName("my-orders").setDescription("내 주문 내역을 확인합니다.")
].map(c => c.toJSON());

function isAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}
function isStaff(interaction) {
  const roleId = process.env.STAFF_ROLE_ID;
  return isAdmin(interaction) || Boolean(roleId && interaction.member?.roles?.cache?.has(roleId));
}
function money(value) { return `${Number(value).toLocaleString("ko-KR")}원`; }
function paymentInfo() {
  return (process.env.PAYMENT_INFO || "결제 방법은 관리자에게 문의해 주세요.").replace(/\\n/g, "\n").slice(0, 1000);
}
function shopEmbed() {
  const products = db.prepare(`
    SELECT p.id, p.name, p.price, p.description, COUNT(s.id) AS stock_count
    FROM products p LEFT JOIN stock s ON s.product_id = p.id
    WHERE p.active = 1 GROUP BY p.id ORDER BY p.id
  `).all();
  const embed = new EmbedBuilder().setColor(0x9b9ba8)
    .setTitle("VOID CORE  |  SOFTWARE STORE")
    .setDescription("구매할 상품을 아래 목록에서 선택하세요. 결제 확인 후 제품 키가 DM으로 전달됩니다.")
    .setFooter({ text: "BEYOND THE LIMITS • VOID CORE" });
  if (!products.length) embed.addFields({ name: "등록된 상품이 없습니다", value: "관리자가 상품을 등록하면 여기에 표시됩니다." });
  else embed.addFields(products.slice(0, 25).map(p => ({
    name: `#${p.id}  ${p.name} — ${money(p.price)}`.slice(0, 256),
    value: `${p.description || "상품 설명 없음"}\n재고: ${p.stock_count > 0 ? `${p.stock_count}개` : "품절"}`.slice(0, 1024),
    inline: false
  })));
  return { embed, products };
}

async function createTicket(interaction) {
  const existing = db.prepare("SELECT channel_id FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'OPEN'")
    .get(interaction.guildId, interaction.user.id);
  if (existing) {
    const existingChannel = await interaction.guild.channels.fetch(existing.channel_id).catch(() => null);
    if (existingChannel) {
      await interaction.reply({ content: `이미 열려 있는 문의가 있어요: ${existingChannel}`, ephemeral: true });
      return;
    }
    db.prepare("UPDATE tickets SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE channel_id = ?").run(existing.channel_id);
  }

  const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16) || "customer";
  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
  ];
  if (process.env.STAFF_ROLE_ID) {
    overwrites.push({ id: process.env.STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }
  const channelOptions = {
    name: `문의-${safeName}`.slice(0, 90),
    type: ChannelType.GuildText,
    topic: `VOID CORE 문의 | 고객 ID: ${interaction.user.id}`,
    permissionOverwrites: overwrites
  };
  if (process.env.TICKET_CATEGORY_ID) channelOptions.parent = process.env.TICKET_CATEGORY_ID;
  const channel = await interaction.guild.channels.create(channelOptions);
  db.prepare("INSERT INTO tickets (guild_id, channel_id, user_id) VALUES (?, ?, ?)")
    .run(interaction.guildId, channel.id, interaction.user.id);

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("voidcore_ticket_close").setLabel("문의 종료").setStyle(ButtonStyle.Danger)
  );
  const welcome = new EmbedBuilder().setColor(0x9b9ba8).setTitle("VOID CORE — SUPPORT")
    .setDescription(`${interaction.user}님, 문의가 접수되었습니다.\n문의 내용을 자세히 남겨주세요. 담당자가 확인 후 답변합니다.\n\n개인정보나 비밀번호, 인증 토큰은 보내지 마세요.`)
    .setFooter({ text: "문의가 해결되면 문의 종료 버튼을 눌러주세요." });
  await channel.send({ content: `${interaction.user}${process.env.STAFF_ROLE_ID ? ` <@&${process.env.STAFF_ROLE_ID}>` : ""}`, embeds: [welcome], components: [closeRow] });
  await interaction.reply({ content: `비공개 문의 채널을 만들었어요: ${channel}`, ephemeral: true });
}

async function closeTicket(interaction) {
  const ticket = db.prepare("SELECT * FROM tickets WHERE channel_id = ? AND status = 'OPEN'").get(interaction.channelId);
  if (!ticket) {
    await interaction.reply({ content: "열려 있는 문의 티켓을 찾을 수 없습니다.", ephemeral: true });
    return;
  }
  if (interaction.user.id !== ticket.user_id && !isStaff(interaction)) {
    await interaction.reply({ content: "문의 작성자 또는 담당 관리자만 종료할 수 있습니다.", ephemeral: true });
    return;
  }
  db.prepare("UPDATE tickets SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP WHERE channel_id = ?").run(interaction.channelId);
  await interaction.channel.permissionOverwrites.edit(ticket.user_id, { ViewChannel: false, SendMessages: false }).catch(() => {});
  await interaction.channel.setName(`closed-${interaction.channel.name}`.slice(0, 100)).catch(() => {});
  await interaction.update({ content: "🔒 문의가 종료되었습니다. 이 채널은 기록 보관을 위해 남겨둡니다.", embeds: [], components: [] });
}

client.once("ready", async () => {
  console.log(`VOID CORE online: ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log("길드 명령어 등록 완료");
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === "shop") {
        const { embed, products } = shopEmbed();
        const available = products.filter(p => p.stock_count > 0).slice(0, 25);
        const components = available.length ? [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId("voidcore_buy").setPlaceholder("구매할 상품을 선택하세요")
            .addOptions(available.map(p => ({ label: `${p.name} — ${money(p.price)}`.slice(0, 100), description: `재고 ${p.stock_count}개 · ID ${p.id}`.slice(0, 100), value: String(p.id) })))
        )] : [];
        await interaction.reply({ embeds: [embed], components }); return;
      }
      if (name === "ticket-panel") {
        if (!isAdmin(interaction)) return interaction.reply({ content: "관리자만 사용할 수 있습니다.", ephemeral: true });
        const panel = new EmbedBuilder().setColor(0x9b9ba8).setTitle("VOID CORE  |  CUSTOMER SUPPORT")
          .setDescription("상품 구매, 결제, 제품 키 및 기타 문의가 있다면 아래 버튼을 눌러주세요.\n고객과 담당자만 볼 수 있는 비공개 문의 채널이 생성됩니다.")
          .setFooter({ text: "BEYOND THE LIMITS • VOID CORE" });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("voidcore_ticket_open").setLabel("문의하기").setEmoji("✉️").setStyle(ButtonStyle.Secondary));
        await interaction.reply({ embeds: [panel], components: [row] }); return;
      }
      if (["add-product", "add-stock", "approve", "orders", "ticket-panel"].includes(name) && !isAdmin(interaction)) {
        await interaction.reply({ content: "관리자만 사용할 수 있는 명령어입니다.", ephemeral: true }); return;
      }
      if (name === "add-product") {
        const productName = interaction.options.getString("name", true).trim().slice(0, 100);
        const price = interaction.options.getInteger("price", true);
        const description = (interaction.options.getString("description") || "").slice(0, 1000);
        const result = db.prepare("INSERT INTO products (name, price, description) VALUES (?, ?, ?)").run(productName, price, description);
        await interaction.reply({ content: `상품 등록 완료: **${productName}** (상품 ID: ${result.lastInsertRowid})`, ephemeral: true }); return;
      }
      if (name === "add-stock") {
        const productId = interaction.options.getInteger("product-id", true);
        const product = db.prepare("SELECT id, name FROM products WHERE id = ? AND active = 1").get(productId);
        if (!product) return interaction.reply({ content: "상품을 찾을 수 없습니다.", ephemeral: true });
        const keys = [...new Set(interaction.options.getString("keys", true).split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
        if (!keys.length) return interaction.reply({ content: "추가할 키가 없습니다.", ephemeral: true });
        if (keys.some(k => k.length > 500)) return interaction.reply({ content: "제품 키는 한 개당 500자 이하여야 합니다.", ephemeral: true });
        const insert = db.prepare("INSERT INTO stock (product_id, license) VALUES (?, ?)");
        db.transaction(items => items.forEach(key => insert.run(productId, key)))(keys);
        await interaction.reply({ content: `**${product.name}** 재고 ${keys.length}개를 추가했습니다.`, ephemeral: true }); return;
      }
      if (name === "approve") {
        const orderId = interaction.options.getInteger("order-id", true);
        const order = db.prepare(`SELECT o.id, o.user_id, o.product_id, p.name FROM orders o JOIN products p ON p.id=o.product_id WHERE o.id=? AND o.status='PENDING'`).get(orderId);
        if (!order) return interaction.reply({ content: "대기 중인 주문을 찾을 수 없습니다.", ephemeral: true });
        const claim = db.transaction(() => {
          const item = db.prepare("SELECT id, license FROM stock WHERE product_id=? ORDER BY id LIMIT 1").get(order.product_id);
          if (!item) throw new Error("재고가 부족합니다.");
          db.prepare("DELETE FROM stock WHERE id=?").run(item.id);
          const changed = db.prepare("UPDATE orders SET status='DELIVERING' WHERE id=? AND status='PENDING'").run(orderId);
          if (!changed.changes) throw new Error("주문이 이미 처리 중이거나 완료되었습니다.");
          return item.license;
        });
        let license;
        try { license = claim(); } catch (e) { return interaction.reply({ content: e.message, ephemeral: true }); }
        await interaction.deferReply({ ephemeral: true });
        let delivered = false;
        try {
          const user = await client.users.fetch(order.user_id);
          await user.send({ embeds: [new EmbedBuilder().setColor(0x9b9ba8).setTitle("VOID CORE — 구매 완료")
            .setDescription(`**${order.name}** 상품이 지급되었습니다.`)
            .addFields({ name: "라이선스 / 제품 키", value: "```\n" + license.slice(0, 900) + "\n```" })
            .setFooter({ text: `주문 번호 #${orderId}` })] });
          delivered = true;
        } catch (e) {
          console.error("DM delivery failed:", e);
        }
        db.prepare("UPDATE orders SET status=?, delivered_at=CURRENT_TIMESTAMP, delivered_license=? WHERE id=?").run(delivered ? "COMPLETED" : "DM_FAILED", license, orderId);
        await interaction.editReply({ content: delivered
          ? `주문 #${orderId} 승인 및 DM 지급 완료.`
          : `주문 #${orderId} 입금은 승인했지만 DM 전송에 실패했습니다. 재고는 중복 지급 방지를 위해 보류 처리했습니다. 관리자 로그를 확인하고 안전한 방법으로 구매자에게 전달하세요.` });
        const logId = process.env.ORDER_LOG_CHANNEL_ID;
        if (logId) {
          const logChannel = await client.channels.fetch(logId).catch(() => null);
          if (logChannel?.isTextBased()) await logChannel.send(`${delivered ? "✅" : "⚠️"} 주문 #${orderId} ${delivered ? "완료" : "DM 전송 실패"} — <@${order.user_id}> / ${order.name}`);
        }
        return;
      }
      if (name === "orders") {
        const rows = db.prepare("SELECT o.id,o.user_id,p.name,o.status,o.created_at FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.id DESC LIMIT 15").all();
        await interaction.reply({ content: rows.length ? rows.map(o => `#${o.id} · <@${o.user_id}> · ${o.name} · ${o.status} · ${o.created_at}`).join("\n").slice(0, 1900) : "주문 내역이 없습니다.", ephemeral: true }); return;
      }
      if (name === "my-orders") {
        const rows = db.prepare("SELECT o.id,p.name,o.status,o.created_at FROM orders o JOIN products p ON p.id=o.product_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 10").all(interaction.user.id);
        await interaction.reply({ content: rows.length ? rows.map(o => `#${o.id} · ${o.name} · ${o.status} · ${o.created_at}`).join("\n") : "주문 내역이 없습니다.", ephemeral: true }); return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === "voidcore_ticket_open") { await createTicket(interaction); return; }
      if (interaction.customId === "voidcore_ticket_close") { await closeTicket(interaction); return; }
    }
    if (interaction.isStringSelectMenu() && interaction.customId === "voidcore_buy") {
      const productId = Number(interaction.values[0]);
      const product = db.prepare(`SELECT p.id,p.name,p.price,COUNT(s.id) AS stock_count FROM products p LEFT JOIN stock s ON s.product_id=p.id WHERE p.id=? AND p.active=1 GROUP BY p.id`).get(productId);
      if (!product || product.stock_count < 1) return interaction.reply({ content: "상품이 품절되었습니다. 상점을 새로고침해 주세요.", ephemeral: true });
      const result = db.prepare("INSERT INTO orders (user_id,product_id) VALUES (?,?)").run(interaction.user.id, productId);
      const orderId = Number(result.lastInsertRowid);
      await interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0x9b9ba8).setTitle("VOID CORE — 주문 생성 완료")
        .setDescription(`**${product.name}** 주문이 생성되었습니다.`)
        .addFields({ name: "주문 번호", value: `#${orderId}`, inline: true }, { name: "결제 금액", value: money(product.price), inline: true },
          { name: "결제 안내", value: paymentInfo() }, { name: "다음 단계", value: "결제 후 문의 버튼을 눌러 주문 번호를 알려주세요. 관리자가 실제 입금을 확인한 뒤 지급합니다." })
        .setFooter({ text: "결제 확인 전에는 상품이 지급되지 않습니다." })] });
      if (process.env.ORDER_LOG_CHANNEL_ID) {
        const logChannel = await client.channels.fetch(process.env.ORDER_LOG_CHANNEL_ID).catch(() => null);
        if (logChannel?.isTextBased()) await logChannel.send(`🛒 새 주문 #${orderId} — <@${interaction.user.id}> / ${product.name} / ${money(product.price)}`);
      }
    }
  } catch (error) {
    console.error(error);
    const message = "처리 중 오류가 발생했습니다. 봇 권한과 설정을 확인하거나 관리자에게 문의해 주세요.";
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
