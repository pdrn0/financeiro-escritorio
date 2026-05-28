const express = require('express');
const Datastore = require('nedb-promises');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const transacoesDb = Datastore.create({ filename: path.join(DATA_DIR, 'transacoes.db'), autoload: true });
const categoriasDb = Datastore.create({ filename: path.join(DATA_DIR, 'categorias.db'), autoload: true });

// Seed categorias
async function seedCategorias() {
  const count = await categoriasDb.count({});
  if (count === 0) {
    await categoriasDb.insert([
      {_id:'1',nome:'Honorários',tipo:'entrada',cor:'#16a34a'},
      {_id:'2',nome:'Consultoria',tipo:'entrada',cor:'#059669'},
      {_id:'3',nome:'Projetos',tipo:'entrada',cor:'#0891b2'},
      {_id:'4',nome:'Outros (entrada)',tipo:'entrada',cor:'#65a30d'},
      {_id:'5',nome:'Aluguel',tipo:'saida',cor:'#dc2626'},
      {_id:'6',nome:'Água / Luz / Internet',tipo:'saida',cor:'#ea580c'},
      {_id:'7',nome:'Material de escritório',tipo:'saida',cor:'#ca8a04'},
      {_id:'8',nome:'Folha de pagamento',tipo:'saida',cor:'#db2777'},
      {_id:'9',nome:'Impostos / Taxas',tipo:'saida',cor:'#7c3aed'},
      {_id:'10',nome:'Softwares / Assinaturas',tipo:'saida',cor:'#4f46e5'},
      {_id:'11',nome:'Marketing',tipo:'saida',cor:'#e11d48'},
      {_id:'12',nome:'Outros (saída)',tipo:'saida',cor:'#94a3b8'}
    ]);
  }
}

async function getCor(categoria) {
  const c = await categoriasDb.findOne({ nome: categoria });
  return c ? c.cor : '#888888';
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/transacoes', async (req, res) => {
  try {
    const { mes, ano } = req.query;
    const q = {};
    if (mes && ano) { q.mes = +mes; q.ano = +ano; }
    else if (ano) { q.ano = +ano; }
    const rows = await transacoesDb.find(q).sort({ data: -1 });
    const cats = await categoriasDb.find({});
    const catMap = {}; cats.forEach(c => catMap[c.nome] = c.cor);
    res.json(rows.map(r => ({ ...r, id: r._id, cor: catMap[r.categoria] || '#888' })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transacoes', async (req, res) => {
  try {
    const { tipo, categoria, descricao, valor, data, pago_por } = req.body;
    if (!tipo || !categoria || !descricao || !valor || !data || !pago_por)
      return res.status(400).json({ error: 'Campos obrigatórios' });
    const d = new Date(data);
    const doc = { tipo, categoria, descricao, valor: parseFloat(valor), data, mes: d.getMonth()+1, ano: d.getFullYear(), pago_por, criado_em: new Date().toISOString() };
    const saved = await transacoesDb.insert(doc);
    const cor = await getCor(categoria);
    res.json({ ...saved, id: saved._id, cor });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/transacoes/:id', async (req, res) => {
  try { await transacoesDb.remove({ _id: req.params.id }, {}); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/categorias', async (req, res) => {
  try {
    const { tipo } = req.query;
    const q = tipo ? { tipo } : {};
    const cats = await categoriasDb.find(q).sort({ _id: 1 });
    res.json(cats.map(c => ({ ...c, id: c._id })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/categorias', async (req, res) => {
  try {
    const { nome, tipo, cor } = req.body;
    const saved = await categoriasDb.insert({ nome, tipo, cor: cor||'#888888' });
    res.json({ ...saved, id: saved._id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/resumo', async (req, res) => {
  try {
    const { mes, ano } = req.query;
    const q = {};
    if (mes && ano) { q.mes = +mes; q.ano = +ano; }
    else if (ano) { q.ano = +ano; }
    const all = await transacoesDb.find(q);
    const anoVal = ano ? +ano : new Date().getFullYear();
    const allAno = await transacoesDb.find({ ano: anoVal });

    const sum = (arr, tipo) => arr.filter(r=>r.tipo===tipo).reduce((s,r)=>s+r.valor,0);
    const sumBy = (arr, tipo, pessoa) => arr.filter(r=>r.tipo===tipo&&r.pago_por===pessoa).reduce((s,r)=>s+r.valor,0);

    const totalEntradas = sum(all,'entrada');
    const totalSaidas = sum(all,'saida');
    const igPagouSaidas = sumBy(all,'saida','igor');
    const pedPagouSaidas = sumBy(all,'saida','pedro');
    const igPagouEntradas = sumBy(all,'entrada','igor');
    const pedPagouEntradas = sumBy(all,'entrada','pedro');

    const cats = await categoriasDb.find({});
    const catMap = {}; cats.forEach(c => catMap[c.nome] = c.cor);

    const catTotals = {};
    all.forEach(r => {
      if (!catTotals[r.categoria]) catTotals[r.categoria] = { categoria: r.categoria, tipo: r.tipo, cor: catMap[r.categoria]||'#888', total: 0 };
      catTotals[r.categoria].total += r.valor;
    });
    const porCategoria = Object.values(catTotals).sort((a,b)=>b.total-a.total);

    const mesTotals = {};
    allAno.forEach(r => {
      const k = r.mes + '_' + r.tipo;
      if (!mesTotals[k]) mesTotals[k] = { mes: r.mes, ano: r.ano, tipo: r.tipo, total: 0 };
      mesTotals[k].total += r.valor;
    });
    const porMes = Object.values(mesTotals).sort((a,b)=>a.mes-b.mes);

    const cotaSaidasCada = totalSaidas*0.5;
    const igCreditoSaidas = igPagouSaidas-cotaSaidasCada;
    const pedCreditoSaidas = pedPagouSaidas-cotaSaidasCada;
    const cotaEntradasIgor = totalEntradas*0.75;
    const cotaEntradasPedro = totalEntradas*0.25;
    const saldoLiquidoIgor = cotaEntradasIgor+igCreditoSaidas;
    const saldoLiquidoPedro = cotaEntradasPedro+pedCreditoSaidas;
    const dividaPedroPagaIgor = Math.max(0,-pedCreditoSaidas);
    const dividaIgorPagaPedro = Math.max(0,-igCreditoSaidas);

    const detalhesIgor = all.filter(r=>r.pago_por==='igor').sort((a,b)=>b.data.localeCompare(a.data)).map(r=>({...r,cor:catMap[r.categoria]||'#888'}));
    const detalhesPedro = all.filter(r=>r.pago_por==='pedro').sort((a,b)=>b.data.localeCompare(a.data)).map(r=>({...r,cor:catMap[r.categoria]||'#888'}));

    res.json({ entradas:totalEntradas, saidas:totalSaidas, saldo:totalEntradas-totalSaidas, porCategoria, porMes,
      relatorio:{ igor:{pagouSaidas:igPagouSaidas,pagouEntradas:igPagouEntradas,cotaSaidas:cotaSaidasCada,cotaEntradas:cotaEntradasIgor,creditoSaidas:igCreditoSaidas,saldoLiquido:saldoLiquidoIgor,detalhes:detalhesIgor},
        pedro:{pagouSaidas:pedPagouSaidas,pagouEntradas:pedPagouEntradas,cotaSaidas:cotaSaidasCada,cotaEntradas:cotaEntradasPedro,creditoSaidas:pedCreditoSaidas,saldoLiquido:saldoLiquidoPedro,detalhes:detalhesPedro},
        dividaPedroPagaIgor,dividaIgorPagaPedro } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

seedCategorias().then(() => {
  app.listen(PORT, () => console.log('Servidor rodando na porta ' + PORT));
}).catch(e => { console.error(e); process.exit(1); });
