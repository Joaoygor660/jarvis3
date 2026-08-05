# enviar-planilha.ps1 — envia a planilha mais recente de uma pasta para o JARVIS.
#
# Esta é a metade da automação que roda no SEU computador. O JARVIS não
# consegue ir buscar o arquivo sozinho porque o sistema de origem só exporta
# por clique — não existe endereço para chamar. Então o combinado é:
#
#     alguém (você ou um robô) põe o .xlsx numa pasta  →  este script envia
#
# Quem põe o arquivo na pasta não importa: pode ser você arrastando, pode ser
# o Power Automate Desktop repetindo seus cliques no sistema. O script é o
# mesmo nos dois casos.
#
# COMO USAR (uma vez):
#   1. Ajuste as três primeiras variáveis abaixo.
#   2. Teste na mão:   powershell -ExecutionPolicy Bypass -File enviar-planilha.ps1
#   3. Agende no Agendador de Tarefas do Windows (instruções no fim do arquivo).
#
# O script NÃO apaga a planilha e NÃO grava nada se o JARVIS recusar o arquivo.

# ─── ajuste aqui ────────────────────────────────────────────────────────────
$Pasta   = "C:\JARVIS\planilhas"                        # onde o .xlsx aparece
$Url     = "https://jarvis3-joao-ygor-s-projects.vercel.app/api/import"
$Token   = $env:JARVIS_INGEST_TOKEN                     # veja a nota de segurança
# ────────────────────────────────────────────────────────────────────────────

$Log = Join-Path $Pasta "envio.log"
function Anota($txt) {
  $linha = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $txt
  Write-Host $linha
  Add-Content -Path $Log -Value $linha -Encoding utf8
}

if (-not $Token) {
  Anota "ERRO: variavel de ambiente JARVIS_INGEST_TOKEN nao definida. Nada enviado."
  exit 1
}
if (-not (Test-Path $Pasta)) {
  Anota "ERRO: pasta nao encontrada: $Pasta"
  exit 1
}

# Pega o .xlsx mais recente, ignorando os temporarios do Excel (~$arquivo.xlsx),
# que aparecem enquanto o arquivo esta aberto e nao sao planilhas de verdade.
$arq = Get-ChildItem -Path $Pasta -Filter *.xlsx |
       Where-Object { -not $_.Name.StartsWith("~`$") } |
       Sort-Object LastWriteTime -Descending |
       Select-Object -First 1

if (-not $arq) { Anota "Nenhuma planilha na pasta. Nada a fazer."; exit 0 }

# Se o robo ainda estiver gravando o arquivo, enviar agora mandaria metade dele.
# Espera o tamanho parar de mudar antes de ler.
$tam1 = $arq.Length
Start-Sleep -Seconds 3
$arq.Refresh()
if ($arq.Length -ne $tam1) { Anota "Arquivo ainda esta sendo gravado. Tento no proximo ciclo."; exit 0 }

Anota "Enviando: $($arq.Name) ($([math]::Round($arq.Length/1KB)) KB)"

try {
  $bytes = [System.IO.File]::ReadAllBytes($arq.FullName)
  $resp = Invoke-RestMethod -Uri $Url -Method Post -Body $bytes -TimeoutSec 120 -Headers @{
    "Content-Type"   = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    "x-ingest-token" = $Token
    "x-arquivo"      = $arq.Name
  }
  if ($resp.ignorado) {
    Anota "OK - planilha igual a anterior, nada mudou no dashboard."
  } else {
    Anota "OK - importado. $($resp.row_count) linhas."
  }
}
catch {
  # O JARVIS recusa de proposito quando o arquivo parece quebrado ou incompleto.
  # Nesse caso a base ANTERIOR continua no ar - e o comportamento desejado.
  $detalhe = $_.ErrorDetails.Message
  if (-not $detalhe) { $detalhe = $_.Exception.Message }
  Anota "RECUSADO/FALHOU: $detalhe"
  exit 1
}

# ─── COMO AGENDAR DE HORA EM HORA ───────────────────────────────────────────
#
# No Agendador de Tarefas do Windows (Iniciar > "Agendador de Tarefas"):
#   Criar Tarefa (nao "Tarefa Basica")
#     Geral    : "Executar estando o usuario conectado ou nao"
#     Disparad.: Diariamente, repetir a cada 1 hora, por 1 dia
#     Acoes    : Iniciar programa
#                Programa : powershell.exe
#                Argumentos: -ExecutionPolicy Bypass -File "C:\JARVIS\enviar-planilha.ps1"
#
# Ou, num prompt de Administrador, de uma vez so:
#
#   schtasks /create /tn "JARVIS - enviar planilha" /sc hourly ^
#     /tr "powershell -ExecutionPolicy Bypass -File C:\JARVIS\enviar-planilha.ps1" /rl highest
#
# ─── SEGURANCA ──────────────────────────────────────────────────────────────
#
# O token NAO deve ser escrito dentro deste arquivo: ele vale como uma senha de
# escrita na base do JARVIS. Guarde-o como variavel de ambiente do usuario:
#
#   setx JARVIS_INGEST_TOKEN "cole-o-token-aqui"
#
# (abra um terminal novo depois; o setx so vale para processos iniciados dali
#  em diante). Se o token vazar, gere outro na Vercel e a chave antiga morre.
