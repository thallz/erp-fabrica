const http = require('http');

function makeRequest(options, postData) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, body: parsed });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        });

        req.on('error', (e) => reject(e));

        if (postData) {
            req.write(JSON.stringify(postData));
        }
        req.end();
    });
}

async function runTests() {
    console.log('🧪 Iniciando testes de integração do Cronograma Maestro (D-1 vs D+0)...\n');

    try {
        // 1. Agendar a OP 3 de MONTAGEM para '2026-06-10' (Quarta-feira)
        console.log('1️⃣ Agendando OP 3 de MONTAGEM para a data X (2026-06-10)...');
        const putRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/producao/op/3/agendar',
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        }, {
            data_programada: '2026-06-10',
            colaborador_id: 1
        });
        console.log(`Status: ${putRes.status}`);
        console.log('--------------------------------------------------\n');

        // 2. Buscar todas as OPs na fila para verificar o desmembramento temporal automático
        console.log('2️⃣ Verificando se OPs de Preparo foram criadas e divididas temporadamente...');
        const filaRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/producao/fila',
            method: 'GET'
        });
        const preparos = (filaRes.body || []).filter(o => o.tipo_op === 'PREPARO');
        
        console.log(`Encontradas ${preparos.length} OPs de Preparo na Fila.`);
        preparos.forEach(op => {
            console.log(`- OP ID: ${op.numero_op} | Receita: ${op.receita_nome} | Data Programada: ${op.data_programada.split('T')[0]} (Tipo: ${op.categoria_producao})`);
        });
        console.log('--------------------------------------------------\n');

        // 3. Testar a geração da ficha de trabalho para o dia da montagem (2026-06-10)
        console.log('3️⃣ Testando GET /api/planejamento/ficha/1/2026-06-10 (Montagem)...');
        const fichaRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/planejamento/ficha/1/2026-06-10',
            method: 'GET'
        });
        console.log(`Status: ${fichaRes.status}`);
        console.log(`Ficha (Montagem D+0):`, JSON.stringify(fichaRes.body, null, 2));
        console.log('--------------------------------------------------\n');

        // 4. Testar a geração da ficha de trabalho para o dia anterior (2026-06-09 - Preparo do Recheio)
        // Agendar a OP de Recheio para o colaborador 1 no dia 2026-06-09 para imprimir
        const opRecheio = preparos.find(p => p.receita_nome.includes('Recheio'));
        if (opRecheio) {
            console.log(`4️⃣ Agendando OP de Preparo de Recheio (${opRecheio.numero_op}) para Colaborador 1 em 2026-06-09...`);
            await makeRequest({
                hostname: 'localhost',
                port: 3001,
                path: `/api/producao/op/${opRecheio.numero_op}/agendar`,
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' }
            }, {
                data_programada: '2026-06-09',
                colaborador_id: 1
            });

            console.log('Consultando ficha de Cozinha (D-1) em 2026-06-09...');
            const fichaCozinhaRes = await makeRequest({
                hostname: 'localhost',
                port: 3001,
                path: '/api/planejamento/ficha/1/2026-06-09',
                method: 'GET'
            });
            console.log(`Ficha Cozinha (D-1):`, JSON.stringify(fichaCozinhaRes.body, null, 2));
            console.log('--------------------------------------------------\n');
        }

        // Limpeza dos dados
        console.log('🧹 Limpando dados de teste...');
        await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/producao/op/3/agendar',
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' }
        }, { data_programada: null, colaborador_id: null });

        for (const op of preparos) {
            await makeRequest({
                hostname: 'localhost',
                port: 3001,
                path: `/api/producao/op/${op.numero_op}/agendar`,
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' }
            }, { data_programada: null, colaborador_id: null });

            await makeRequest({
                hostname: 'localhost',
                port: 3001,
                path: `/api/producao/op/${op.numero_op}`,
                method: 'DELETE'
            });
        }
        console.log('Dados de teste limpos.');

        console.log('🎉 Todos os testes de Cronograma Maestro concluídos com sucesso!');
    } catch (err) {
        console.error('❌ Falha nos testes de integração:', err.message);
    }
}

runTests();
