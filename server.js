const express = require('express');
const initSqlJs = require('sql.js');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'financeiro.db');

let db = null;
let dbReady = false;

// Start HTTP server IMMEDIATELY so Railway health check passes
app.listen(PORT, () => console.log('Servidor na porta ' + PORT));

// Then initialize database async
initSqlJs().then(SQL => {
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS transacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tipo TEXT NOT NULL, categoria TEXT NOT NULL,
      descricao TEXT NOT NULL, valor REAL NOT NULL, data TEXT NOT NULL,
      mes INTEGER NOT NULL, ano INTEGER NOT NULL, pago_por TEXT NOT NULL DEFAULT 'igor',
      criado_em TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL, tipo TEXT NOT NULL, cor TEXT DEFAULT '#888888'
    );
    INSERT OR IGNORE INTO categorias (id, nome, tipo, cor) VALUES
      (1, 'Honor\u00e1rios', 'entrada', '#16a34a'),(2, 'Consultoria', 'entrada', '#059669'),
      (3, 'Projetos', 'entrada', '#0891b2'),(4, 'Outros (entrada)', 'entrada', '#65a30d'),
      (5, 'Aluguel', 'saida', '#dc2626'),(6, '\u00c1gua / Luz / Internet', 'saida', '#ea580c'),
      (7, 'Material de escrit\u00f3rio', 'saida', '#ca8a04'),(8, 'Folha de pagamento', 'saida', '#db2777'),
      (9, 'Impostos / Taxas', 'saida', '#7c3aed'),(10, 'Softwares / Assinaturas', 'saida', '#4f46e5'),
      (11, 'Marketing', 'saida', '#e11d48'),(12, 'Outros (sa\u00edda)', 'saida', '#94a3b8');
  `);
  try { db.run("ALTER TABLE transacoes ADD COLUMN pago_por TEXT NOT NULL DEFAULT 'igor'"); } catch(e) {}
  dbReady = true;
  console.log('Banco de dados pronto!');
}).catch(e => console.error('Erro DB:', e));

function saveDB() { if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql); const rows = [];
  stmt.bind(params); while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows;
}
function queryOne(sql, params = []) { return queryAll(sql, params)[0] || null; }
function run(sql, params = []) {
  db.run(sql, params); saveDB();
  return db.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0];
}

// Middleware: wait for DB
const waitDB = (req, res, next) => {
  if (!dbReady) return res.status(503).json({ error: 'Inicializando banco de dados...' });
  next();
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/transacoes', waitDB, (req, res) => {
  const { mes, ano } = req.query;
  let sql = `SELECT t.id, t.tipo, t.categoria, t.descricao, t.valor, t.data, t.mes, t.ano, t.pago_por, c.cor FROM transacoes t LEFT JOIN categorias c ON t.categoria = c.nome`;
  const p = [];
  if (mes && ano) { sql += ' WHERE t.mes=? AND t.ano=?'; p.push(+mes, +ano); }
  else if (ano) { sql += ' WHERE t.ano=?'; p.push(+ano); }
  sql += ' ORDER BY t.data DESC, t.id DESC';
  res.json(queryAll(sql, p));
});

app.post('/api/transacoes', waitDB, (req, res) => {
  const { tipo, categoria, descricao, valor, data, pago_por } = req.body;
  if (!tipo || !categoria || !descricao || !valor || !data || !pago_por) return res.status(400).json({ error: 'Campos obrigatorios' });
  const d = new Date(data); const mes = d.getMonth() + 1; const ano = d.getFullYear();
  const id = run('INSERT INTO transacoes (tipo,categoria,descricao,valor,data,mes,ano,pago_por) VALUES (?,?,?,?,?,?,?,?)', [tipo, categoria, descricao, parseFloat(valor), data, mes, ano, pago_por]);
  res.json(queryOne('SELECT t.*,c.cor FROM transacoes t LEFT JOIN categorias c ON t.categoria=c.nome WHERE t.id=?', [id]));
});

app.delete('/api/transacoes/:id', waitDB, (req, res) => { run('DELETE FROM transacoes WHERE id=?', [+req.params.id]); res.json({ ok: true }); });

app.get('/api/categorias', waitDB, (req, res) => {
  const { tipo } = req.query;
  res.json(tipo ? queryAll('SELECT * FROM categorias WHERE tipo=? ORDER BY id', [tipo]) : queryAll('SELECT * FROM categorias ORDER BY tipo, id'));
});

app.post('/api/categorias', waitDB, (req, res) => {
  const { nome, tipo, cor } = req.body;
  const id = run('INSERT INTO categorias (nome,tipo,cor) VALUES (?,?,?)', [nome, tipo, cor||'#888888']);
  res.json({ id, nome, tipo, cor });
});

app.get('/api/resumo', waitDB, (req, res) => {
  const { mes, ano } = req.query;
  let where = ''; const p = [];
  if (mes && ano) { where = 'WHERE mes=? AND ano=?'; p.push(+mes, +ano); }
  else if (ano) { where = 'WHERE ano=?'; p.push(+ano); }
  const totais = queryAll(`SELECT tipo, SUM(valor) as total FROM transacoes ${where} GROUP BY tipo`, p);
  const porCategoria = queryAll(`SELECT t.categoria, t.tipo, c.cor, SUM(t.valor) as total FROM transacoes t LEFT JOIN categorias c ON t.categoria=c.nome ${where} GROUP BY t.categoria ORDER BY total DESC`, p);
  const anoVal = ano ? +ano : new Date().getFullYear();
  const porMes = queryAll('SELECT mes, ano, tipo, SUM(valor) as total FROM transacoes WHERE ano=? GROUP BY mes, tipo ORDER BY mes', [anoVal]);
  const totalEntradas = totais.find(t => t.tipo==='entrada')?.total || 0;
  const totalSaidas = totais.find(t => t.tipo==='saida')?.total || 0;
  const pagamentos = queryAll(`SELECT pago_por, tipo, SUM(valor) as total FROM transacoes ${where} GROUP BY pago_por, tipo`, p);
  const igPagouSaidas = pagamentos.find(r => r.pago_por==='igor' && r.tipo==='saida')?.total || 0;
  const pedPagouSaidas = pagamentos.find(r => r.pago_por==='pedro' && r.tipo==='saida')?.total || 0;
  const igPagouEntradas = pagamentos.find(r => r.pago_por==='igor' && r.tipo==='entrada')?.total || 0;
  const pedPagouEntradas = pagamentos.find(r => r.pago_por==='pedro' && r.tipo==='entrada')?.total || 0;
  const cotaSaidasCada = totalSaidas * 0.5;
  const igCreditoSaidas = igPagouSaidas - cotaSaidasCada; const pedCreditoSaidas = pedPagouSaidas - cotaSaidasCada;
  const cotaEntradasIgor = totalEntradas * 0.75; const cotaEntradasPedro = totalEntradas * 0.25;
  const saldoLiquidoIgor = cotaEntradasIgor + igCreditoSaidas; const saldoLiquidoPedro = cotaEntradasPedro + pedCreditoSaidas;
  const dividaPedroPagaIgor = Math.max(0, -pedCreditoSaidas); const dividaIgorPagaPedro = Math.max(0, -igCreditoSaidas);
  const wp = where ? where + ' AND' : 'WHERE';
  const detalhesIgor = queryAll(`SELECT t.categoria, t.tipo, t.descricao, t.valor, t.data, c.cor FROM transacoes t LEFT JOIN categorias c ON t.categoria=c.nome ${wp} t.pago_por='igor' ORDER BY t.data DESC`, p);
  const detalhesPedro = queryAll(`SELECT t.categoria, t.tipo, t.descricao, t.valor, t.data, c.cor FROM transacoes t LEFT JOIN categorias c ON t.categoria=c.nome ${wp} t.pago_por='pedro' ORDER BY t.data DESC`, p);
  res.json({ entradas: totalEntradas, saidas: totalSaidas, saldo: totalEntradas - totalSaidas, porCategoria, porMes,
    relatorio: { igor: { pagouSaidas: igPagouSaidas, pagouEntradas: igPagouEntradas, cotaSaidas: cotaSaidasCada, cotaEntradas: cotaEntradasIgor, creditoSaidas: igCreditoSaidas, saldoLiquido: saldoLiquidoIgor, detalhes: detalhesIgor },
      pedro: { pagouSaidas: pedPagouSaidas, pagouEntradas: pedPagouEntradas, cotaSaidas: cotaSaidasCada, cotaEntradas: cotaEntradasPedro, creditoSaidas: pedCreditoSaidas, saldoLiquido: saldoLiquidoPedro, detalhes: detalhesPedro },
      dividaPedroPagaIgor, dividaIgorPagaPedro } });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
