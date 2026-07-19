const pool = require('./src/config/db');
const fs = require('fs');
const path = require('path');

async function reset() {
    console.log('⏳ Executando reset do banco de dados...');
    try {
        const sqlPath = path.join(__dirname, 'reset_db.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await pool.query(sql);
        console.log('✅ Banco de dados resetado com sucesso para início de dados reais!');
    } catch (e) {
        console.error('❌ Erro ao resetar banco de dados:', e.message);
    } finally {
        await pool.end();
    }
}

reset();
