const http = require('http');

// Helper to make JSON requests
const makeRequest = (options, postData = null) => {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve({ status: res.statusCode, body: jsonData });
                } catch (e) {
                    resolve({ status: res.statusCode, error: 'Could not parse JSON', raw: data });
                }
            });
        });
        req.on('error', (e) => { reject(e); });
        if (postData) {
            req.write(JSON.stringify(postData));
        }
        req.end();
    });
};

async function runTests() {
    console.log('🧪 Iniciando testes de integração de Planejamento...\n');

    try {
        // Teste 1: Buscar sugestões semanais baseadas em pedidos CRIADOS
        console.log('1️⃣ Testando sugestão semanal baseada em pedidos ativos...');
        const sugRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/planejamento/sugestao-semanal',
            method: 'GET'
        });
        console.log(`Status: ${sugRes.status}`);
        console.log(`Sugestões obtidas:`, JSON.stringify(sugRes.body, null, 2));
        console.log('--------------------------------------------------\n');

        // Teste 2: Validar capacidade de colaborador
        console.log('2️⃣ Testando validação de capacidade do colaborador...');
        // Simulando que vamos alocar OP #1 para o colaborador Maria Silva (ID 1)
        const capRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/planejamento/validar',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            colaborador_id: 1,
            data_programada: '2026-06-10',
            ops: [{ op_id: 3 }] // Se a OP existir no banco
        });
        console.log(`Status: ${capRes.status}`);
        console.log(`Resultado da capacidade:`, JSON.stringify(capRes.body, null, 2));
        console.log('--------------------------------------------------\n');

        // Teste 3: Listar OPs programadas para hoje
        console.log('3️⃣ Testando listagem de OPs programadas para hoje...');
        const hojeRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: `/api/producao/programadas-hoje?data=2026-06-10`,
            method: 'GET'
        });
        console.log(`Status: ${hojeRes.status}`);
        console.log(`OPs programadas:`, JSON.stringify(hojeRes.body, null, 2));
        console.log('--------------------------------------------------\n');

        // Teste 4: Verificar se a divisão (split) de OP funciona
        console.log('4️⃣ Testando divisão e redistribuição de OP...');
        const splitRes = await makeRequest({
            hostname: 'localhost',
            port: 3001,
            path: '/api/planejamento/split-op',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, {
            op_id: 3, // Supondo OP #3 existe
            quantidade_colaborador_1: 40,
            colaborador_1_id: 1,
            data_1: '2026-06-10',
            quantidade_colaborador_2: 60,
            colaborador_2_id: 2,
            data_2: '2026-06-10'
        });
        console.log(`Status: ${splitRes.status}`);
        console.log(`Resultado da divisão:`, JSON.stringify(splitRes.body, null, 2));
        console.log('--------------------------------------------------\n');

        console.log('🎉 Todos os testes de planejamento concluídos!');
    } catch (err) {
        console.error('❌ Falha ao rodar testes. Certifique-se de que a API está rodando na porta 3001:', err.message);
    }
}

runTests();
