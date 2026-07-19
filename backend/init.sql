-- ==========================================
-- SCRIPT DE INICIALIZAÇÃO: init.sql
-- BANCO DE DADOS: banco-dados-erp
-- ==========================================

-- 1. ALMOXARIFADO E INSUMOS
CREATE TABLE insumo (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    unidade_medida VARCHAR(10) NOT NULL, -- Ex: 'kg', 'g', 'l', 'ml', 'un'
    custo_unitario DECIMAL(10, 4) NOT NULL, -- Precisão extra para centavos
    estoque_atual DECIMAL(10, 4) DEFAULT 0.0000
);

-- 2. EMBALAGENS (Controle separado de insumos por ter lógica diferente no CMV)
CREATE TABLE embalagem (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    custo_unitario DECIMAL(10, 4) NOT NULL,
    estoque_atual INT DEFAULT 0
);

-- 3. PRODUTOS ACABADOS (O que vai para a venda)
CREATE TABLE produto (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    preco_venda DECIMAL(10, 2) NOT NULL,
    cmv_estimado DECIMAL(10, 2), -- Atualizado via API toda vez que um insumo muda de preço
    margem_contribuicao DECIMAL(5, 2), -- Porcentagem (%)
    estoque_atual INT DEFAULT 0, -- Câmara Fria (produto acabado)
    peso_produtividade FLOAT DEFAULT 1.0,
    categoria VARCHAR(50) DEFAULT 'Geral',
    categoria_producao VARCHAR(50) DEFAULT 'Geral'
);

-- 4. FICHAS TÉCNICAS (A "Receita" do Produto para Cálculo em Cascata)
CREATE TABLE ficha_tecnica_insumo (
    produto_id INT REFERENCES produto(id) ON DELETE CASCADE,
    insumo_id INT REFERENCES insumo(id) ON DELETE RESTRICT,
    quantidade DECIMAL(10, 4) NOT NULL, -- Quanto de insumo vai em 1 lote/unidade
    PRIMARY KEY (produto_id, insumo_id)
);

CREATE TABLE ficha_tecnica_embalagem (
    produto_id INT REFERENCES produto(id) ON DELETE CASCADE,
    embalagem_id INT REFERENCES embalagem(id) ON DELETE RESTRICT,
    quantidade INT NOT NULL,
    PRIMARY KEY (produto_id, embalagem_id)
);

-- 4b. RECEITAS (Massas, Recheios e Pré-Preparos)
CREATE TABLE receita (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    categoria VARCHAR(50) DEFAULT 'Geral',
    custo_total DECIMAL(12, 4) DEFAULT 0,
    peso_total DECIMAL(12, 4) DEFAULT 0,
    custo_por_kg DECIMAL(12, 4) DEFAULT 0,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE receita_item (
    id SERIAL PRIMARY KEY,
    receita_id INT NOT NULL REFERENCES receita(id) ON DELETE CASCADE,
    tipo_origem VARCHAR(10) NOT NULL CHECK (tipo_origem IN ('materia', 'receita')),
    origem_id INT NOT NULL,
    nome VARCHAR(100) NOT NULL,
    quantidade_gramas DECIMAL(12, 4) NOT NULL,
    custo_unitario DECIMAL(12, 4) DEFAULT 0,
    custo DECIMAL(12, 4) DEFAULT 0
);

-- 5. CONFIGURAÇÃO DE INTERCORRÊNCIAS (Padrões da Fábrica)
CREATE TABLE tipo_intercorrencia (
    codigo VARCHAR(2) PRIMARY KEY,
    descricao VARCHAR(100) NOT NULL,
    afeta_meta BOOLEAN DEFAULT TRUE
);

-- Populando as intercorrências padrão que você definiu
INSERT INTO tipo_intercorrencia (codigo, descricao) VALUES
('M1', 'Manutenção Mecânica (Falha em Equipamento)'),
('E1', 'Falta de Energia / Instabilidade Elétrica'),
('P1', 'Problema de Processo / Qualidade de Massa/Recheio'),
('O1', 'Ociosidade / Falta de Demanda ou Insumo');

-- 5b. COLABORADORES (Equipe de Produção)
CREATE TABLE colaborador (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    meta_diaria INT DEFAULT 350, -- Meta padrão de 350 unidades por dia
    meta_diaria_individual INT DEFAULT 350,
    eh_novato BOOLEAN DEFAULT FALSE,
    ativo BOOLEAN DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Inserir alguns colaboradores de exemplo
INSERT INTO colaborador (nome, meta_diaria) VALUES
('Maria Silva', 350),
('João Santos', 400),
('Ana Costa', 350);

-- 6. FILA DE PRODUÇÃO (Bateladas)
CREATE TABLE ordem_producao (
    id SERIAL PRIMARY KEY,
    produto_id INT REFERENCES produto(id),
    quantidade_planejada INT NOT NULL,
    quantidade_realizada INT DEFAULT 0,
    status VARCHAR(20) DEFAULT 'FILA', -- 'FILA', 'PRODUZINDO', 'CONCLUIDA', 'PAUSADA'
    data_inicio TIMESTAMP,
    data_fim TIMESTAMP,
    colaborador_id INT REFERENCES colaborador(id), -- Colaborador responsável
    data_programada DATE, -- Data planejada para produção
    categoria_producao VARCHAR(50),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. APONTAMENTO DE CHÃO DE FÁBRICA (Onde os códigos entram)
CREATE TABLE apontamento_intercorrencia (
    id SERIAL PRIMARY KEY,
    ordem_producao_id INT REFERENCES ordem_producao(id) ON DELETE CASCADE,
    codigo_intercorrencia VARCHAR(2) REFERENCES tipo_intercorrencia(codigo),
    tempo_parada_minutos INT NOT NULL,
    observacao TEXT,
    registrado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. CLIENTES (B2B)
CREATE TABLE cliente (
    id SERIAL PRIMARY KEY,
    razao_social VARCHAR(200) NOT NULL,
    cnpj VARCHAR(20) UNIQUE NOT NULL,
    telefone VARCHAR(20),
    criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. PEDIDOS (Vendas)
CREATE TABLE pedido (
    id SERIAL PRIMARY KEY,
    cliente_id INT REFERENCES cliente(id) ON DELETE RESTRICT,
    data_pedido TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data_entrega DATE,
    status VARCHAR(20) DEFAULT 'CRIADO', -- 'CRIADO', 'PRODUZINDO', 'FATURADO', 'ENTREGUE'
    valor_total DECIMAL(10, 2) DEFAULT 0.00
);

-- 10. ITENS DO PEDIDO
CREATE TABLE item_pedido (
    pedido_id INT REFERENCES pedido(id) ON DELETE CASCADE,
    produto_id INT REFERENCES produto(id) ON DELETE RESTRICT,
    quantidade INT NOT NULL,
    preco_unitario DECIMAL(10, 2) NOT NULL,
    PRIMARY KEY (pedido_id, produto_id)
);