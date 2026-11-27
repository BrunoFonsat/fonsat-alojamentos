# Fonsat · Alojamentos

## A ideia

Controlo simples e direto dos alojamentos (casas e apartamentos) onde a Fonsat aloja os seus funcionários deslocados. Responde a quatro perguntas:

1. **Quanto custa cada casa e cada pessoa alojada?** A empresa paga sempre o custo total. Queremos saber quanto custa cada pessoa naquela casa.
2. **Quantas camas temos, quantas estão ocupadas e quantas estão livres?**
3. **Quem está em que casa, desde quando e porquê?** Entradas, saídas e transferências, sempre com motivo.
4. **Onde ficam as casas?** Mapa de cada casa e mapa geral com todas.

É um projeto **totalmente separado** da calculadora de custo por hora (`fonsat-custos`): repositório, endereço, base de dados e utilizadores próprios. Não há ligação entre os dois.

## Nome: «alojamento»

Na aplicação diz-se sempre **«alojamento»** (masculino), nunca «casa»: «Novo alojamento», «Alojamento vazio», «Cheios», «Inativos»… No código continua `house`/`casa`, por exemplo a rota `#/casa/<id>`.

## Organização: delegações

- A Fonsat tem três **delegações** que gerem casas: **Astúrias, Catalunha e Porto**.
- A casa pertence à delegação que a **gere**, não à que fica mais perto. Por exemplo, uma casa em Santander pode ser gerida pelas Astúrias.
- A **região** é a cidade ou zona onde a casa fica (Oviedo, Gijón, Santander, Barcelona…). Serve só para filtrar.

## Utilizadores e perfis (feito a 26/11/2026)

| Perfil | Vê | Pode |
|---|---|---|
| **Gestor** | Todas as delegações e o painel geral | Tudo: alterar, importar e exportar em todas. Gere os **utilizadores** e o código de autorização. |
| **Coordenador** | Só a sua delegação | Ver, alterar, importar e exportar só na sua delegação. Alterar casas já criadas pede o código do gestor. |
| **Administrativo** | **Todas as delegações ou uma** (escolhe-se ao criar) | **Só ver.** Pode exportar Excel e ver telefones. **Não** vê o histórico de edições, não importa e não altera nada. |

- Login com email e palavra-passe, sem MFA. O primeiro gestor é `gerencia@fonsat.pt`.
- **Só leitura garantida no servidor:** o Administrativo recebe 403 em qualquer pedido que não seja de leitura, exceto sair e mudar a sua palavra-passe, e também em `/api/audit`. Na página, os botões de alteração ficam escondidos (`W()` / `RO()` em `public/app.js`).
- **Utilizadores** (menu, só o gestor): criar, editar e desativar.
  - Campos: nome, email, perfil e delegação.
  - **Desativar** em vez de apagar, para o histórico manter o nome.
  - Mudar perfil, delegação, email ou desativar **termina as sessões** dessa pessoa, para as permissões novas valerem logo.
  - O gestor não se desativa nem perde o perfil a si próprio, e há sempre pelo menos um gestor ativo.
  - Tudo fica no histórico (`entity='user'`), sem palavras-passe.
- **Palavra-passe temporária:**
  - ao criar um utilizador, a aplicação gera uma temporária, por exemplo `Kx7m-p4Qr-9tWz`. É mostrada **uma única vez** ao gestor, para a enviar à pessoa;
  - no 1.º login a pessoa é **obrigada a escolher a sua** (mínimo 10 caracteres, diferente da temporária). Até lá o servidor só aceita mudar a palavra-passe ou sair;
  - mudar a palavra-passe termina as outras sessões.
- **Repor palavra-passe** (gestor, em Utilizadores → Editar): gera uma temporária nova (mostrada uma vez, com «Copiar email e palavra-passe»), obriga a escolher outra no próximo login, termina as sessões dessa pessoa e limpa as tentativas falhadas dela. **Não reativa** contas inativas. Não serve para a própria conta (`POST /api/users/:id/reset`).
- **Mudar a própria palavra-passe:** botão de cadeado no cartão do utilizador (fundo do menu), para qualquer perfil (`POST /api/auth/password`).
- **Código de autorização do gestor:** um código à parte, diferente do login, definido pelo gestor em «Definições».
  - **Não há código por omissão.** Numa BD nova, nada que precise dele é autorizado até o gestor o definir. Só os dados de teste (`seed-demo`) gravam `fonsat1234`.
  - Os **coordenadores** precisam dele para:
    - **editar uma casa já criada** (valores como o aluguer, dados, inativar, apagar);
    - **mudar o pino de sítio**;
    - **corrigir ou apagar registos de entradas e saídas** (movimentos históricos).
  - **Não** precisam dele para criar casas, pôr o primeiro pino, **confirmar** um pino no mesmo sítio, dar entrada, saída ou transferência, ou lançar despesas reais do mês.
  - O **gestor nunca** precisa dele.
  - Guardado em hash (scrypt), nunca em texto. É verificado no servidor, com limite de 8 tentativas por 15 minutos por utilizador (bloqueia mesmo que depois acerte), e fica no histórico («autorizado com o código do gestor»).
- Cada alteração fica no **histórico de edições**: quem, quando, e o valor antes e depois.
- Mais tarde: permissões mais finas, por exemplo um coordenador só de leitura.

## Regras de negócio

- **Custo mensal da casa** = aluguer + despesas do mês.
  - As despesas são um **valor fixo mensal** (o habitual).
  - Num mês diferente lança-se o **acerto**, que substitui o valor fixo só nesse mês.
- **Custo por pessoa** = custo mensal ÷ pessoas alojadas **hoje**.
  - Exemplo: aluguer 500 € + despesas 500 €, com 2 pessoas = 500 € por pessoa.
- **Lotação:** máxima (camas), ocupada (hoje) e disponível (máxima − ocupada).
  - Só contam como ocupação os funcionários com **entrada numa casa** (estadia ativa hoje). Pendentes e sem casa nunca contam.
- **Ocupação e lotação desconhecidas** (regra de 26/11/2026):
  - uma casa só é «Vazia» ou «Com camas livres» quando a **lotação** e a **ocupação** são conhecidas;
  - lotação desconhecida = sem lotação preenchida;
  - ocupação desconhecida = a casa **nunca teve registos de ocupantes** e ninguém confirmou que está vazia;
  - nesses casos o estado é **«Por confirmar»** (roxo nos pinos, cards e filtros) e as camas não contam como livres, nem nos totais nem na transferência;
  - na ficha há o botão **«Confirmar que está vazia»**: grava a data (`occ_checked`) e fica no histórico. Não pede código, porque é um facto, não um valor. É recusado se houver alguém alojado.
  - Nos totais (painel, delegação, grupo do mapa), a ocupação compara-se **só com as casas com lotação e ocupação conhecidas**. Quem está em casas sem lotação definida (ex.: os hotéis) aparece à parte («+93 em 27 casas sem lotação»). Antes somava-se tudo e dava, por exemplo, 160/126 (127 %).
  - A lotação **pode ser excedida**. O sistema deixa, mas mostra um alerta.
- **Dar entrada** só com um funcionário **que já existe**: a janela pesquisa por nome, profissão ou telefone entre os que estão sem casa (incluindo os pendentes). Para criar alguém usa-se «Funcionários → Novo funcionário». O servidor recusa entradas só com um nome, para evitar repetidos.
- **Entrada e saída** têm sempre data e **motivo obrigatório**. O motivo é texto livre com sugestões: início de obra, fim de obra, transferência, férias, fim de contrato…
- **Data de saída = dia em que sai** (como o check-out), a partir de 27/11/2026. Nesse dia a pessoa **já não conta** no alojamento e fica logo disponível para outro. Alojado no dia d ⇔ entrada ≤ d e (sem saída ou saída > d).
  - Antes, a data contava como «último dia lá»: dar saída hoje deixava a pessoa no alojamento até amanhã e bloqueada para outro. Corrigido no servidor, na página e nos scripts, com teste.
  - As saídas que existiam (2, ambas de 27/11) já tinham o significado «saiu hoje» e não foram alteradas.
- **Transferência:** sai do alojamento antigo e entra no novo **no mesmo dia** (a data indicada), com o mesmo motivo, num só passo. Tem de ser depois do dia de entrada.
  - Destinos possíveis: só casas **ativas**, nunca a própria casa de origem, e só da delegação do utilizador (o gestor vê todas).
  - A ocupação e as camas livres são calculadas **à data da transferência**: conta quem lá está nesse dia.
  - Casa **cheia ou acima da lotação:** é permitido, mas mostra a ocupação resultante (ex.: «7 pessoas para 6 camas») e pede **confirmação explícita**. O servidor volta a calcular e recusa sem `confirm_over: true`; fica no histórico «acima da lotação, confirmado».
  - Casas com **lotação desconhecida** ficam à parte e nunca contam como disponíveis.
  - Não pede o código do gestor.
- A mesma pessoa **não pode estar em duas casas ao mesmo tempo**.
- **Quartos** (habitaciones) dentro de um alojamento (feito a 26/11/2026). O alojamento continua a ser **um só**: um custo e uma lotação.
  - Cada quarto tem nome e número de camas. Com quartos, **a lotação e o n.º de quartos do alojamento são calculados** (soma das camas) e o formulário já não os muda.
  - Criar, alterar ou apagar quartos muda a lotação, por isso **pede o código do gestor** aos coordenadores. Há «Criar vários» (ex.: Habitación 1 a 14, 3 camas). Um quarto com registos de ocupantes não se apaga.
  - **Ao criar um alojamento** podem acrescentar-se logo os quartos, cada um com as suas camas («Quarto» ou «N quartos de M camas»); a lotação fica calculada. Depois de criado, gerem-se em «Dados».
  - Cada ocupante pode ter quarto: escolhe-se ao **dar entrada** (opcional) e muda-se com **«Quarto»**, que é um movimento e não pede código. Fica no histórico. Numa transferência para outro alojamento, o quarto fica por escolher.
  - A ficha mostra os ocupantes **agrupados por quarto** (ocupação, camas livres, completo) e um grupo «Sem quarto atribuído».
  - Tabela `rooms`, coluna `stays.room_id`. Script `scripts/import-rooms.js` (cria quartos e atribui quartos a quem já lá está; não cria pessoas; quem aparece em dois quartos fica sem quarto).
- **Responsável do alojamento e lista semanal** (feito a 26/11/2026):
  - Cada alojamento tem um **responsável**, que é um dos ocupantes atuais. Nomeia-se com ★ na lista de ocupantes (é um movimento, não pede código). Aparece **em destaque e primeiro** na lista.
  - Quem sai ou é transferido deixa de ser responsável.
  - Todos os ocupantes mostram o **telefone**. Sem telefone, aparece a etiqueta «Sem telefone» e alertas no alojamento: «Sem responsável», «Responsável sem telefone», «N ocupantes sem telefone».
  - **Idioma** de cada funcionário: Espanhol, Português ou vazio (= espanhol), escolhido à mão na ficha.
  - **«Pedir lista (WhatsApp)»**:
    - cria um **link único** (7 dias, só desse alojamento; guarda-se só o hash) e abre o WhatsApp (`wa.me`) com a mensagem escrita, que se pode editar;
    - a mensagem vai no idioma do responsável: «Bom dia» ou «Buenos días» antes das 12h, «Boa tarde» ou «Buenas tardes» depois;
    - número sem indicativo: assume 351 (Porto) ou 34 (resto);
    - quem envia é o utilizador, num clique. **Não há envio automático** (exigiria a WhatsApp Business API).
  - **Página do responsável** (`/lista/<código>`, sem login, `public/lista.html` e `lista.js`):
    - mostra só o nome do alojamento e os nomes dos ocupantes, sem telefones;
    - o responsável marca «Está» ou «Ya no está» e escreve nomes novos e um comentário;
    - limite de pedidos por IP.
  - **Correções** (menu, com o n.º por decidir; também na ficha do alojamento). O responsável **só informa**: nada muda até o gestor ou o coordenador decidir.
    - Cada **saída informada**: «Dar saída» ou «Recusar».
    - Cada **pessoa nova**, com decisão obrigatória:
      - **associar** a um funcionário que já existe (sugestões e pesquisa entre todos os que não estão já neste alojamento). Se estiver **noutro alojamento**, aparece «X está no alojamento «Y». Deseja transferi-lo?» → «Sim, transferir» e, ao aplicar, uma confirmação final. A transferência é **hoje** (sai de Y e entra aqui no mesmo dia). Sem confirmação o servidor devolve 422 (`needTransfer`); se Y for de outra delegação, o coordenador recebe 403;
      - **criar** um funcionário novo (fica pendente de completar);
      - **recusar**.
    - «Aplicar decisões» só fica ativo com tudo decidido, e o servidor recusa decisões incompletas (422).
    - «Recusar tudo» = nada muda.
    - Fica registado no pedido (`checkins.decision`) e no histórico o que foi **aceite** e o que foi **recusado** («Tratadas recentemente»).
    - Não pede código.
  - **Mensagem** (curta), por exemplo: «Boa tarde, Bruno. Clica no link e confirma quem está contigo no alojamento «X»: [link] — Se o link não abrir, guarda o meu contacto ou copia o link e cola no navegador.» (ou a versão em espanhol).
  - **Página do responsável:** depois de enviar, fica só o agradecimento («¡Gracias!» ou «Obrigado!»). Se reabrir o link antes da decisão, pode corrigir o que enviou.
  - **«Pedir a todos»** (no título de «Listas semanais» no painel, e em «Ações → Pedir listas aos responsáveis» em cada delegação):
    - fila em sequência com os alojamentos ocupados, com responsável e ainda sem pedido esta semana. Uma opção junta também os que receberam e não responderam;
    - os links são todos criados no início (`POST /api/checkins/bulk`), porque o navegador só deixa abrir o WhatsApp logo no clique;
    - cada passo tem a mensagem editável e os botões «Abrir WhatsApp e seguinte», «Copiar» e «Saltar». Os que não têm telefone ficam no fim, com «Copiar e seguinte»;
    - na prática, 10 responsáveis levam cerca de 1 minuto: um clique aqui e o Enviar no WhatsApp;
    - **envio automático**, por agora, não: exigiria a WhatsApp Business Platform (conta Meta verificada, número próprio, modelos aprovados, custo por mensagem). Estimativa de 26/11/2026, segundo fontes não oficiais e a confirmar na tabela da Meta: ~0,014–0,02 € por mensagem de utilidade, ou seja ~2–3 €/mês com uma mensagem por responsável.
  - **Painel → «Listas semanais»** (semana de segunda a domingo): aplicadas, por aplicar, à espera, por pedir e sem responsável, com o botão «Pedir».
  - **Importante:** o link só funciona no telemóvel do responsável **depois de a aplicação estar publicada** (Vercel). Em `localhost` só abre neste computador.
- **Nada com histórico se apaga:**
  - uma casa com ocupantes ou despesas lançadas não pode ser apagada, nem pelo gestor; **inativa-se**. Só se apaga uma casa criada por engano, ainda sem histórico;
  - um funcionário com registos de alojamento também não se apaga.
- **Pinos no mapa:**
  - as coordenadas mantêm-se enquanto a morada não mudar (editar outros campos não mexe no pino nem volta a pesquisar);
  - um pino **colocado à mão nunca é substituído** sem aviso. Se a morada ou o link mudarem, fica onde está e marcado **«Localização por confirmar»**;
  - um pino automático volta a ser procurado se a morada mudar;
  - os pinos importados que não chegaram ao número da porta (só rua ou localidade) também ficam «por confirmar».
- **Alertas:**
  - lotação excedida;
  - contrato a terminar em 60 dias ou menos, ou já terminado;
  - casa ativa vazia;
  - lotação por preencher;
  - sem localização no mapa;
  - localização por confirmar.
- **Funcionários:** lista própria dos alojamentos, sem ligação à calculadora.
  - Guarda-se o mínimo (RGPD): nome, **profissão**, **telefone** e, se útil, empresa/obra.
  - **Pendente** = funcionário **sem delegação** (e sem casa).
    - Todos os coordenadores veem os pendentes, para lhes poderem dar entrada.
    - Ao dar entrada num alojamento, o pendente passa a ter a delegação desse alojamento.
  - **Alojamento próprio** (`own_housing`): a pessoa não precisa de alojamento da empresa. Marca-se na ficha ou no Excel, e sai da lista «sem alojamento». Dar entrada num alojamento desmarca-o.
  - **Por rever** = sem delegação, sem alojamento e sem alojamento próprio. Aparece um alerta no painel e na lista de funcionários, com o filtro «Por rever».
    - Só o gestor muda a delegação de um funcionário, e pode deixá-lo pendente.
  - Sem NIF nem documentos.

## Dados de cada casa

- Nome do piso (único)
- Edifício (opcional): andares do mesmo prédio têm o mesmo edifício
- Código (opcional, único, ex.: AS-001)
- Delegação
- Região
- Morada (endereço escrito)
- Localização (link do Google Maps)
- Aluguer mensal, dia de vencimento da renda (1 a 31) e despesas fixas mensais
- Lotação máxima e n.º de quartos
- Proprietário
- Início e fim do contrato
- Caução (valor + disponível sim/não)
- Ativa sim/não
- Notas

## Excel: modelo padrão (importar e exportar), feito a 26/11/2026

Um ficheiro com as folhas **«Alojamentos»**, **«Funcionários»** e **«Instruções»**.
- Listas de escolha na delegação e nos campos Sim/Não.
- A **exportação** sai no mesmo formato (exporta-se, completa-se e volta a importar-se). Exportar e reimportar sem mudar nada dá «sem alterações» em todas as linhas.
- **Dentro de cada delegação**, no botão **«Ações ▾»** (menu com «Exportar Excel» e «Importar Excel»), ao lado de «Mapa» e «Novo alojamento». Não há página Excel no menu lateral.
  - Cada ficheiro é de **uma delegação**: exporta os alojamentos e os funcionários dessa delegação. Os pendentes, sem delegação, não entram.
  - Ao importar, uma linha sem delegação fica com a da importação. Uma linha de outra delegação, ou de um alojamento ou funcionário que pertence a outra delegação, dá erro.
  - O coordenador só exporta e importa a sua delegação. O administrativo só exporta as delegações que vê, e não importa.
  - Na janela «Importar» há os links «Descarregar os dados atuais» e «Modelo vazio».
- Código: `src/server/excel.js`, rotas `/api/excel/modelo`, `/api/excel/exportar`, `/api/excel/previsualizar` e `/api/excel/importar`. Testes em `test/excel.test.js`.

**Folha «Alojamentos»**

| Col. | Campo |
|---|---|
| A | Nome do piso* |
| B | Delegação* |
| C | Região |
| D | Morada |
| E | Localização (link) |
| F | Aluguer |
| G | Despesas fixas |
| H | Lotação |
| I | Quartos |
| J | Proprietário |
| K | Início do contrato |
| L | Fim do contrato |
| M | Caução |
| N | Caução disponível |
| O | Ativa |
| P | Notas |
| Q | Código |
| R | Dia de vencimento |
| S | Edifício |

**Folha «Funcionários»** (só dados da pessoa: as entradas nas casas fazem-se na aplicação)

| Col. | Campo |
|---|---|
| A | Nome* |
| B | Profissão |
| C | Telefone |
| D | Delegação (Astúrias, Catalunha, Porto ou **Pendente**) |
| E | Empresa / obra |
| F | Alojamento próprio (Sim/Não) |

**Regras da importação**
- **Pré-visualização obrigatória**, com o resultado de cada linha e o seu número no Excel: nova, preenche vazios, sem alterações, erro ou possível duplicado.
  - Ao gravar, o servidor volta a ler e a validar tudo; nunca confia na pré-visualização.
  - Só se gravam as linhas válidas. As linhas com erro ficam de fora e aparecem listadas.
- **Formato (erros fatais):**
  - o ficheiro não é um .xlsx;
  - falta a folha;
  - falta uma coluna obrigatória;
  - mais de 2000 linhas.
- **Avisos de formato:** colunas em falta ou que não fazem parte do modelo. As colunas reconhecem-se pelo nome, por isso a ordem pode mudar.
- **Erros por linha:**
  - campo obrigatório vazio;
  - número, inteiro ou data inválidos (aceita dd/mm/aaaa, datas do Excel e «1.250,50»);
  - delegação desconhecida (aceita também AST, CAT e POR);
  - Sim/Não inválido;
  - link que não é https;
  - fim do contrato antes do início;
  - nome ou código repetido no ficheiro;
  - código de uma casa com o nome de outra;
  - célula com erro do Excel.
- **Avisos por linha:**
  - lotação 0 («deixe vazio se não souber»);
  - aluguer 0;
  - telefone com letras;
  - diferenças entre o Excel e a aplicação («mantém-se …»).
- **Casas:**
  - reconhecem-se pelo **código** ou, sem código, pelo **nome do piso**. A comparação mantém os algarismos (AS-001 ≠ AS-002, Calle Mayor 7 ≠ 11);
  - se a casa já existir, **só se preenchem os campos vazios**. Nunca se apaga nem substitui, e a delegação e Sim/Não nunca mudam.
- **Funcionários:**
  - reconhecem-se pelo nome (`src/server/names.js`): igual, ou parecido com todas as palavras a bater (fica a nota «nome parecido»);
  - quando falta uma palavra ou há vários candidatos, a linha é um **possível duplicado** e não entra;
  - sem delegação, ficam pendentes (gestor) ou na delegação do coordenador.
- **Coordenadores:**
  - só importam a sua delegação: outra delegação dá erro, e a delegação em branco passa a ser a sua;
  - preencher casas que já existem pede o **código do gestor**.
- Tudo fica no histórico com «(importação Excel)».

## Ecrãs

1. **Painel geral** (gestor e administrativo de todas as delegações). Cartões de resumo: **Alojamentos** (ativos, inativos, por confirmar), Ocupação, Camas livres, Custo mensal, Custo por pessoa. Cartões por delegação com o total de alojamentos.
   Detalhe:
   - um card por delegação: casas, ocupadas/lotação, livres, custo mensal, custo por pessoa, alertas;
   - totais gerais e lista de alertas.
2. **Delegação:**
   - números da delegação e lista de casas, com filtros por região, estado (ativa ou inativa) e ocupação (livres, cheias, acima da lotação, vazias);
   - cada coordenador entra diretamente aqui.
3. **Ficha da casa:**
   - números e alertas;
   - ocupantes de hoje, com «Dar entrada» e, em cada pessoa, «Saída» e «Transferir» (a mesma janela, com um seletor para trocar). Na transferência:
     - escolhe-se primeiro a **região/zona** (começa na da casa atual) e depois a casa;
     - aparecem primeiro as casas **com camas livres** (as com mais camas primeiro), com ocupação e camas livres;
     - abaixo, secções que se expandem: «Cheias ou acima da lotação» e «Lotação desconhecida»;
     - a lógica de escolha está em `public/transfer.js`, testada em `test/transfer.test.js`;
   - dados da casa, com edição e «Ver no mapa»;
   - custos por mês, com acertos;
   - histórico de entradas e saídas, e histórico de edições.
4. **Funcionários:** filtros «Todos · Sem alojamento · Alojamento próprio · Por rever». Lista com nome, profissão, telefone (clicável), delegação («Pendente» se não tiver) e casa atual.
   - Pesquisa por nome, profissão ou telefone.
   - Filtros por **delegação** (incluindo «Pendentes») e **profissão**, e «Sem casa».
5. **Histórico de edições.**
6. **Excel:** descarregar o modelo, exportar, importar com pré-visualização (ver acima).
7. **Utilizadores** (gestor): criar, editar e desativar contas; perfil e delegação; palavra-passe temporária.

## Visual: decidido e feito em 26/11/2026

- **Mais clean:** visual moderno (mais espaço, cantos arredondados, sombras suaves, ícones, menu lateral) e **menos informação à vista**. Os detalhes aparecem ao clicar.
- **Tema claro, escuro ou automático**, com um botão para alternar. A escolha fica guardada no navegador.
- **Casas em cards ou em lista**, com um botão para alternar.
- **Mapa geral com todas as casas** em pinos (OpenStreetMap com Leaflet, sem conta nem chave):
  - pino colocado **automaticamente pela morada** (pesquisa no OpenStreetMap/Nominatim) e ajustável arrastando-o no mapa;
  - só a morada da casa sai para o serviço de pesquisa, nunca nomes de pessoas.
- **Cores pela ocupação** (nos pinos e nos cards): verde = camas livres, amarelo = cheia, vermelho = acima da lotação, cinzento = vazia ou inativa.
- **Mapa geral:**
  - o pino mostra a sigla da delegação (**AST** Astúrias, **CAT** Catalunha, **POR** Porto);
  - o popup mostra nome, delegação, região, ocupação, camas livres, custo mensal, custo por pessoa e o botão «Abrir ficha»;
  - filtros por delegação, região, estado (ativa ou inativa) e ocupação.
- **Localização:**
  - latitude e longitude guardadas na BD;
  - ao criar ou editar uma casa, procura logo a morada;
  - se falhar, o pino coloca-se à mão;
  - a ficha da casa tem o **mini-mapa sempre visível no topo**, com «Editar localização» (arrastar, clicar ou «Procurar pela morada»).
- **Alerta «Sem localização no mapa»** para casas ativas sem pino.
- **Pinos agrupados** (Leaflet.markercluster 1.5.3, copiado em `public/vendor/markercluster/`):
  - casas próximas juntam-se num círculo com o número;
  - o anel do círculo divide-se pelas cores das casas do grupo (verde, amarelo, vermelho, cinzento);
  - ao clicar, o mapa aproxima-se e abre **ao lado a lista das casas do grupo** (ocupação, €/pessoa, «Ficha»);
  - clicar numa casa da lista leva o mapa até ao pino e abre o popup;
  - casas no mesmo prédio abrem em leque.
- **Edifícios:**
  - casas com o mesmo «Edifício» (mesma delegação, sem distinguir maiúsculas) são **andares** de um prédio. Cada andar continua a ser uma casa à parte, com renda, lotação e ocupantes próprios;
  - no mapa ficam **num só pino** (quadrado, com a sigla e o número de andares). O popup mostra a ocupação e o custo totais e a lista dos andares com link para cada ficha;
  - mudar o pino de um andar **move o edifício todo**;
  - o coordenador precisa do código sempre que o **edifício** já tenha pino, mesmo que o andar a partir do qual muda ainda não o tivesse. Isto fecha o caminho «criar um andar novo e pôr-lhe o primeiro pino». Confirmar no mesmo sítio não pede código;
  - **cada andar afetado** fica com o seu registo no histórico («… alterado a partir de «andar»», com a nota de autorização);
  - um andar novo, ou uma casa que passa a ter o edifício, **herda o pino** do edifício sem mexer nos outros;
  - agrupar casas num edifício só com confirmação de que são o mesmo prédio. A Calle Real (AS-001 a AS-003) **não** está agrupada.
  - a ficha mostra o edifício e os links para os outros andares;
  - **nas listas da delegação** (cards e lista), os andares aparecem juntos num **cartão do edifício**, com a ocupação, a lotação e o custo somados e cada andar por baixo (ocupação, camas livres, link para a ficha). Na vista em lista: uma linha do edifício e os andares indentados.
  - Exemplo: CT-005 a CT-008 = «C/ VALLÉS 6, LLEIDA».
- **Filtros do mapa:**
  - **não se guardam entre visitas**: ao abrir a aplicação, o mapa mostra sempre todas as casas ativas;
  - quando há filtros ativos, aparece um aviso com quantas casas estão escondidas e o botão «Mostrar todas»;
  - o coordenador vê um aviso de que só vê a sua delegação.
- **Grupos de pinos:** mostram o número de casas e a **sigla da delegação** (ex.: «8 CAT»), para se distinguirem mesmo quando estão todos cinzentos (vazios).
- **«Confirmar localização»** na ficha, quando o pino está por confirmar. Não pede código, porque o pino não muda de sítio.

## Movimento (animações)

- Discreto e sem repetir: o conteúdo **só entra com animação quando se muda de página** (subida e opacidade curtas, cartões em cascata, barras de ocupação a crescer).
- Redesenhar a mesma página (depois de guardar, mudar o tema…) **não** volta a animar.
- Também animam a abertura de janelas, do menu «Ações» e as mensagens de confirmação (só a primeira vez).
- Desligado para quem tem «reduzir movimento» ativo no sistema (`prefers-reduced-motion`).

## Fica para depois

- Património da empresa dentro de cada casa.
- Permissões finas por utilizador.

## Técnico

- Node ≥ 20, sem framework. O servidor está em `src/server/` e a página em `public/` (JavaScript simples, sem `innerHTML`).
- Base de dados libSQL: ficheiro local em `data/alojamentos.sqlite`, ou Turso em produção (`ALOJ_DB_URL` + `ALOJ_DB_TOKEN`).
- Alojamento no Vercel: `api/index.js` serve todas as rotas `/api/*`, e `public/` é estático.
- **Segurança:**
  - palavras-passe com scrypt;
  - sessão em cookie HttpOnly;
  - CSRF;
  - limite de tentativas de login;
  - CSP só `'self'`, que tem de ser alargada com cuidado para os mosaicos do mapa e a pesquisa de moradas;
  - todas as leituras e escritas filtradas pela delegação do utilizador **no servidor**.
- Testes: `npm test`, com os testes em `test/`.

### Comandos

- `npm start`: arranca em http://localhost:3100.
- `npm run seed:demo -- --reset`: apaga a BD local e cria **dados de teste fictícios** (13 casas, 36 funcionários).
- `node scripts/import-houses.js <ficheiro.json> [--substituir] [--sem-mapa]`: importa casas reais de um JSON preparado.
  - Os ficheiros ficam em `data/import/`, fora do git.
  - `--substituir` apaga primeiro os dados de teste dessa delegação. Só funciona na BD local.
  - Procura os pinos no OpenStreetMap; os que ficam ao nível da rua ou da localidade ficam «por confirmar».
- `node scripts/import-workers.js <ficheiro.md> [--simular] [--comparar-com=asturias,catalunha] [--duvidas=criar]`: importa a lista de funcionários (tabela Markdown: nome | profissão | telefone).
  - **Nunca repete:**
    - compara primeiro os nomes iguais (sem acentos);
    - depois os parecidos (uma letra trocada, apelidos a mais, ordem diferente), sempre o par mais semelhante primeiro;
    - quem já existe recebe o nome da lista, a profissão e o telefone, e mantém a casa e a delegação.
  - Os outros são criados como **pendentes**.
  - **Correr sempre primeiro com `--simular` e rever o relatório.**
- `node scripts/import-stays-by-name.js <ficheiro.json> [--simular]`: dá entrada a funcionários **já existentes** a partir de uma lista «nome → alojamento» de outra origem.
  - Os nomes comparam-se com `src/server/names.js`, o mesmo módulo de `import-workers.js`.
  - Só associa sem ambiguidade. Pseudónimos confirmados à mão vão em `aliases`.
  - Não cria pessoas nem casas. Não mexe em quem já está alojado.
  - A data de entrada é a do registo da origem.
  - Pode correr-se de novo sem repetir nada.
- `node scripts/import-occupants.js <ficheiro.json>`: dá entrada a funcionários nas casas, identificadas pelo código.
  - Reutiliza funcionários com o mesmo nome.
  - Ignora quem já está alojado.
- `ALOJ_PASSWORD=... npm run user:create -- <email> "<nome>" <gestor|coordenador|administrativo> [delegação]`: cria um utilizador ou repõe a palavra-passe (administrativo sem delegação = vê todas).

## Estado (26/11/2026)

- **Feito:**
  - painel, delegações, ficha da casa (com separadores Ocupantes, Custos, Dados e Histórico);
  - entradas, saídas e transferências com motivo, acertos de despesas, funcionários, histórico de edições;
  - perfis gestor/coordenador e dados de teste;
  - visual novo (menu lateral, tema claro/escuro/auto, cards ou lista, formulários em janelas);
  - mapa geral e mapa da casa: pino pela morada, pelo link do Google Maps ou arrastado à mão (este manda sempre).

  - reforço de segurança: sem código por omissão, correções de movimentos com código, nada com histórico se apaga, pinos manuais protegidos;
  - campos Código e Dia de vencimento;
  - pinos agrupados no mapa.

  42 testes a passar.
- **Dados reais** (Astúrias, Catalunha, Porto, hotéis, quartos): o estado das importações e o que falta confirmar estão em `data/import/ESTADO-DADOS.md`. Esse ficheiro **fica fora do git**, porque tem nomes de pessoas (RGPD). Lê-lo antes de mexer em dados reais.
- **Por fazer:** repositório no GitHub e publicação (Vercel + Turso).
- O Leaflet 1.9.4 está copiado em `public/vendor/leaflet/` (a CSP só permite scripts do próprio site). Para o atualizar, voltar a copiá-lo de `node_modules/leaflet/dist/`.
- O repositório **não** pode ter nomes, telefones ou outros dados de pessoas reais: os testes usam nomes fictícios e os dados reais ficam em `data/` (no `.gitignore`).

## Como trabalhar neste projeto

- **Fazer perguntas antes de construir** funcionalidades novas, até ter a informação necessária. Não criar páginas provisórias com base em suposições.
- Responder em português de Portugal.
- Usar dados fictícios em testes. Com dados reais de pessoas, guardar o mínimo necessário (RGPD).
