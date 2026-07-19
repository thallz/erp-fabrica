const express = require('express');
const cors = require('cors');
const pool = require('./config/db');
const { runMigrations } = require('./config/migrate');
const insumoRoutes = require('./routes/insumoRoutes');
const produtoRoutes = require('./routes/produtoRoutes');
const producaoRoutes = require('./routes/producaoRoutes');
const comercialRoutes = require('./routes/comercialRoutes');
const financeiroRoutes = require('./routes/financeiroRoutes');
const receitaRoutes = require('./routes/receitaRoutes');
const planejamentoRoutes = require('./routes/planejamentoRoutes');
const colaboradorRoutes = require('./routes/colaboradorRoutes');

const app = express();
const PORT = 3001;

app.use(cors());

// Bruno e alguns clientes enviam body "null" em GET — strict:false evita crash
app.use(express.json({ strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/insumos', insumoRoutes);
app.use('/api/produtos', produtoRoutes);
app.use('/api/producao', producaoRoutes);
app.use('/api/comercial', comercialRoutes);
app.use('/api/financeiro', financeiroRoutes);
app.use('/api/receitas', receitaRoutes);
app.use('/api/planejamento', planejamentoRoutes);
app.use('/api/colaboradores', colaboradorRoutes);

// ==========================================
// ROTA DE TESTE (Para rodar no Bruno)
// ==========================================
app.get('/api/status', async (req, res) => {
    try {
        // Pede a hora atual para o banco de dados para provar que a conexão é real
        const dbResult = await pool.query('SELECT NOW() AS data_atual');
        
        res.json({
            status: 'online',
            sistema: 'ERP Fábrica de Salgados',
            banco_de_dados: 'Conectado!',
            data_servidor: dbResult.rows[0].data_atual
        });
    } catch (error) {
        res.status(500).json({ status: 'erro', erro: error.message });
    }
});

runMigrations()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`🚀 Servidor da API rodando na porta ${PORT}`);
        });
    })
    .catch((err) => {
        console.error('❌ Falha nas migrações:', err.message);
        process.exit(1);
    });