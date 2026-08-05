// api/_parse.js — leitura da planilha do lado do SERVIDOR.
//
// Prefixo "_" → não vira rota na Vercel (não conta no limite de 12 funções).
//
// Estas funções eram exclusivas do navegador, dentro do index.html. Enquanto
// viviam lá, importar dados exigia uma PESSOA com a tela aberta clicando em
// "Novo arquivo Excel" — nenhuma automação era possível, por construção.
// Foram copiadas para cá SEM alteração de regra: o resultado de um mesmo
// arquivo é idêntico ao do navegador, para que as duas portas de entrada
// (upload manual e robô) nunca divirjam.
//
// Ao mexer nas regras de leitura, altere NOS DOIS lugares — index.html e aqui.

const XLSX = require("xlsx");

// Constantes que vivem noutro ponto do index.html (linhas 3004 e 3106) e que o
// parser consome. Copiadas com o mesmo conteúdo — se mudarem lá, mude aqui.
const RT_INDISP=new Set(["INSS","ABANDONO","FALTA","FOLGA","SUSPENSAO","SUSPENSÃO","FERIAS"]);
const CK_MODELOS=new Set(["LIMPEZA","PORTARIA","VISITA DE ROTEIRO"]);

function isoDate(v){
  if(v===null||v===undefined||v==="")return null;
  if(v instanceof Date){
    const y=v.getFullYear(),m=String(v.getMonth()+1).padStart(2,"0"),d=String(v.getDate()).padStart(2,"0");
    return `${y}-${m}-${d}`;
  }
  if(typeof v==="number"){
    try{const d=XLSX.SSF.parse_date_code(v);if(d)return `${d.y}-${String(d.m).padStart(2,"0")}-${String(d.d).padStart(2,"0")}`;}catch(e){}
  }
  const s=String(v).trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  const p=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if(p){const yr=p[3].length===2?"20"+p[3]:p[3];return yr+"-"+String(p[1]).padStart(2,"0")+"-"+String(p[2]).padStart(2,"0");}
  const p2=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  return s;
}
function turnoFromEscala(esc,hrEntrada){
  const e=String(esc||"").toUpperCase();
  if(!e.includes("12X36"))return"DIURNO";
  // 12X36: noturno somente se entrada >= 18:00
  if(hrEntrada!=null){
    let h=null;
    if(typeof hrEntrada==="number"){
      // Excel serial fraction: 0.75 = 18:00
      h=hrEntrada*24;
    }else{
      const m=String(hrEntrada).match(/(\d{1,2})[:\h](\d{2})/);
      if(m)h=parseInt(m[1],10)+parseInt(m[2],10)/60;
    }
    if(h!=null)return h>=18?"NOTURNO":"DIURNO";
  }
  return"NOTURNO"; // sem hora, mantém noturno como fallback conservador
}
function normTxt(v){
  return String(v||"").trim().toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
}
function findSheet(wb,name){
  const target=normTxt(name);
  for(const n of wb.SheetNames){if(normTxt(n)===target)return wb.Sheets[n];}
  return null;
}
function sheetRows(ws){
  if(!ws)return{idx:{},body:[]};
  const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:null});
  if(!rows.length)return{idx:{},body:[]};
  const hdr=rows[0];
  const idx={};
  hdr.forEach((h,i)=>{if(h!==null&&h!==undefined)idx[String(h).trim()]=i;});
  return{idx,body:rows.slice(1)};
}
function buildDataFromWorkbook(wb){
  const data={};
  function ext(sheetName,mapFn,key){
    const ws=findSheet(wb,sheetName);
    const{idx,body}=sheetRows(ws);
    data[key]=(body||[]).filter(r=>r&&r.length).map(r=>mapFn(r,idx)).filter(Boolean);
  }
  // Tenta ler da Ficha de Presença unificada (substitui FALTAS + FTS + COBERTURA)
  const wsFicha=findSheet(wb,"FICHA PRESENCA")||findSheet(wb,"FICHA DE PRESENCA")||findSheet(wb,"FICHA");
  if(wsFicha){
    const fichaRows=XLSX.utils.sheet_to_json(wsFicha,{raw:true,defval:null});
    const faltas=[],ftsArr=[],cobArr=[];
    for(const r of fichaRows){
      const nome=r["NOMEFUNCIONARIO"];
      if(!nome||String(nome).trim()==="")continue;
      const tipo=(r["DESCTPCOBERTURA"]||"").toUpperCase().trim();
      const sit=(r["DESCSITUACAOHOJE"]||"").toUpperCase().trim();
      const base={
        NOME:nome,DATA:isoDate(r["DATA"]),LOCAL:r["NOMELOCAL"],
        CARGO:r["DESC_CARGO"],AREA:r["AREASUPERVISAO"],
        TIPO:r["TPCLIENTE"],TURNO:turnoFromEscala(r["DESCESCALA"],r["HRENTRADA"])
      };
      if(sit.includes("FALT")||sit.includes("AUSENCIA")||sit.includes("AUSÊNCIA"))
        faltas.push({...base,ABONO:r["DESCTPABONO"]||"—"});
      const cargoVaga=r["CARGO_VAGA"]||r["DESC_CARGO"]||"—"; // cargo do POSTO coberto (não o do colaborador)
      if(tipo==="FT")
        ftsArr.push({...base,CARGO:cargoVaga,MOTIVO:r["DESCIMPLA"]||"—"});
      if(tipo==="COBERTURA"||tipo==="DOBRA"||tipo==="CONVOCACAO"||tipo==="CONVOCAÇÃO")
        cobArr.push({NOME:base.NOME,DATA:base.DATA,LOCAL:base.LOCAL,AREA:base.AREA,TURNO:base.TURNO,CARGO:cargoVaga,MOTIVO:r["DESCIMPLA"]||"—"});
    }
    data.faltas=faltas;data.fts=ftsArr;data.cobertura=cobArr;
  }else{
    ext("FALTAS",(r,I)=>({
      NOME:r[I["NOMEFUNCIONARIO"]],DATA:isoDate(r[I["DATA"]]),
      LOCAL:r[I["NOMELOCAL"]],CARGO:r[I["DESC_CARGO"]],
      AREA:r[I["AREASUPERVISAO"]],ABONO:r[I["DESCTPABONO"]],
      TIPO:r[I["TPCLIENTE"]],TURNO:turnoFromEscala(r[I["DESCESCALA"]],r[I["HRENTRADA"]])
    }),"faltas");
    ext("FTS",(r,I)=>{
      const nomeF=r[I["NOMEFUNCIONARIO"]];
      if(nomeF===null||nomeF===undefined||String(nomeF).trim()==="")return null;
      return{
        NOME:nomeF,DATA:isoDate(r[I["DATA"]]),
        LOCAL:r[I["NOMELOCAL"]],CARGO:r[I["DESC_CARGO"]],
        AREA:r[I["AREASUPERVISAO"]],TIPO:r[I["TPCLIENTE"]],
        TURNO:turnoFromEscala(r[I["DESCESCALA"]],r[I["HRENTRADA"]]),MOTIVO:r[I["DESCIMPLA"]]
      };
    },"fts");
    ext("COBERTURA",(r,I)=>({
      NOME:r[I["NOMEFUNCIONARIO"]],DATA:isoDate(r[I["DATA"]]),
      LOCAL:r[I["NOMELOCAL"]],AREA:r[I["AREASUPERVISAO"]],CARGO:r[I["DESC_CARGO"]],
      TURNO:turnoFromEscala(r[I["DESCESCALA"]],r[I["HRENTRADA"]]),MOTIVO:r[I["DESCIMPLA"]]
    }),"cobertura");
  }
  const wsHE=findSheet(wb,"HR EXTRA")||findSheet(wb,"HORAS EXTRAS")||findSheet(wb,"HREXTRA");
  if(wsHE){
    const heRows=XLSX.utils.sheet_to_json(wsHE,{raw:false,defval:""});
    if(heRows.length){
      const keys=Object.keys(heRows[0]);
      const fk=function(names){for(const n of names){const found=keys.find(k=>k.trim().toUpperCase()===n.toUpperCase());if(found)return found;}return null;};
      const kMin=fk(["MINUTOS"])||keys.find(k=>k.trim().toUpperCase()==="MINUTOS");
      const kFunc=fk(["FUNCIONARIO","NOMEFUNCIONARIO"]);
      const kData=fk(["DATA"]);
      const kLocal=fk(["LOCAL"]);
      const kCli=fk(["CLIENTE"]);
      const kArea=fk(["AREASUPERVISAO"]);
      const kCargo=fk(["NOMECARGOFUNCIONARIO"]);
      const kMotivo=fk(["MOTIVO"]);
      const kTipo=fk(["TIPOEXTRA"]);
      console.log("[HR EXTRA] kMin="+kMin,"sample="+JSON.stringify(heRows[0][kMin]),"tipo="+typeof heRows[0][kMin],"keys="+keys.length);
      data.hrextra=heRows.map(r=>{
        let seg=0;
        if(kMin){
          const raw=r[kMin];
          if(typeof raw==="number"&&raw>0&&raw<2){seg=Math.round(raw*24*3600);}
          else if(raw instanceof Date){const iso=raw.toISOString();const p=iso.match(/T(\d+):(\d+):(\d+)/);if(p)seg=parseInt(p[1])*3600+parseInt(p[2])*60+parseInt(p[3]);}
          else{
            const minStr=String(raw||"");
            const p=minStr.match(/(\d+):(\d+):?(\d+)?/);
            if(p)seg=parseInt(p[1])*3600+parseInt(p[2])*60+(parseInt(p[3])||0);
          }
        }
        return{
          NOME:kFunc?r[kFunc]:"—",DATA:isoDate(kData?r[kData]:""),
          LOCAL:kLocal?r[kLocal]:"—",CLIENTE:(kCli?r[kCli]:"")||(kLocal?r[kLocal]:"")||"—",
          AREA:kArea?r[kArea]:"—",CARGO:kCargo?r[kCargo]:"—",
          MOTIVO:kMotivo?r[kMotivo]:"—",TIPO:kTipo?r[kTipo]:"—",
          MINUTOS:seg,TURNO:"DIURNO"
        };
      }).filter(Boolean);
    }else{data.hrextra=[];}
  }else{data.hrextra=[];console.warn("[HR EXTRA] Guia não encontrada. Guias:",wb.SheetNames.join(", "));}
  ext("NOVOS CLIENTES",(r,I)=>{
    const cli=r[I["CLIENTE"]];
    if(cli===null||cli===undefined||String(cli).trim()==="")return null;
    return{CLIENTE:cli,DATA:isoDate(r[I["DATA DA IMPLANTAÇÃO"]])};
  },"novosClientes");
  ext("JUSTIFICATIVA VAGA DESCOBERTA",(r,I)=>({
    DATA:isoDate(r[I["DATA"]]),LOCAL:r[I["LOCALSERVICO"]],
    CARGO:r[I["DESCCARGO"]],AREA:r[I["AREA"]],
    TURNO:r[I["DESCTURNO"]],MOTIVO:r[I["DESCMOTIVO"]]
  }),"justif");
  ext("OS AVULSOS",(r,I)=>{
    const tipoCol=I["TIPO DE OS"]??I["TIPO OS"]??I["TIPOOS"]??I["TIPO"];
    const tipo=(r[tipoCol]||"").toString().toUpperCase().trim();
    // Data do serviço = DTPONTO (o dia em que o serviço foi de fato prestado).
    // Antes usava DTINICIO, que é o início da SOLICITAÇÃO: numa OS que se estende
    // por vários dias, todas as linhas repetem o mesmo DTINICIO e variam o DTPONTO,
    // então a guia empilhava tudo no dia da abertura. Sem retorno a outra coluna de
    // data — usar DTINICIO como reserva reintroduziria exatamente essa divergência.
    const dtCol=I["DTPONTO"]??I["DT PONTO"]??I["DATAPONTO"]??I["DATA PONTO"];
    return{
      DATA:isoDate(r[dtCol]),LOCAL:r[I["NOMELOCAL"]],
      CARGO:r[I["CARGO"]],TIPO:tipo,
      TURNO:(r[I["TURNO"]]||"").toString().toUpperCase().trim(),
      STATUS:r[I["SITSOLICITACAO"]],
      RESPONSAVEL:r[I["NOMESOLICITACAONTE"]],NOME:r[I["NOMEFUNC"]]
    };
  },"os");
  ext("DISPONIBILIDADE DE PLANTÃO",(r,I)=>({
    DATA:isoDate(r[I["DATA"]]),NOME:r[I["FUNCIONARIO"]],
    TURNO:r[I["TURNO"]],RESERVA:r[I["RESERVA"]],
    SITUACAO:r[I["SITUACAOPONTO"]],AREA:r[I["AREASUPERVISAO"]],
    CARGO:r[I["CARGOVAGA"]]
  }),"dispo");
  ext("CLIENTES",(r,I)=>({
    NOME:r[I["CLIENTE"]],TPCLIENTE:r[I["TPCLIENTE"]],
    TURNO:r[I["TURNO"]],AREA:r[I["AREALOCAL"]],
    EMPRESA:r[I["EMPRESA"]]||"—"
  }),"clientes");
  ext("FICHA DE PRESENÇA",(r,I)=>{
    const tpc=function(){
      for(const k of Object.keys(I)){const u=k.toUpperCase().replace(/[\s_]/g,"");if(u==="TPCLIENTE"||u==="TIPOCLIENTE")return r[I[k]];}
      return r[I["TPCLIENTE"]]||r[I["TpCliente"]]||r[I["TIPOCLIENTE"]]||r[I["Tipo Cliente"]]||r[I["TIPO"]]||"";
    }();
    return{RE:r[I["RE"]],NOME:r[I["FUNCIONARIO"]]!==undefined?r[I["FUNCIONARIO"]]:r[I["NOMEFUNCIONARIO"]],
    DATA:isoDate(r[I["DATA"]]),
    DESCSITUACAO:r[I["DESCSITUACAO"]],DESCSITUACAOHOJE:r[I["DESCSITUACAOHOJE"]],
    NOMELOCAL:r[I["NOMELOCAL"]]||"",
    TPCLIENTE:tpc||""};
  },"presenca");
  const _presDedup={};
  (data.presenca||[]).forEach(r=>{
    if(r.RE!=null){
      const k=String(r.RE)+"|"+String(r.NOME||"");
      if(!_presDedup[k]||String(r.DATA||"")>String(_presDedup[k].DATA||""))_presDedup[k]=r;
    }
  });
  data.presenca=Object.values(_presDedup);
  const wsA=findSheet(wb,"FUNCIONARIOS ATIVOS");
  const sa=sheetRows(wsA);
  const emps={};
  (sa.body||[]).forEach(r=>{
    if(!r||!r.length)return;
    const re_=r[sa.idx["RE"]];
    const nome_=r[sa.idx["FUNCIONARIO"]];
    if(re_===null||re_===undefined)return;
    const key=String(re_)+"|"+String(nome_||"");
    if(!(key in emps)){
      emps[key]={
        RE:re_,NOME:nome_,CARGO:r[sa.idx["CARGO"]]||"—",
        AREA:r[sa.idx["AREASUPERVISAO"]]||"—",ESCALA:r[sa.idx["ESCALA"]]||"—",
        TPCLIENTE:r[sa.idx["CLIENTE"]]||"—",LOCAL:r[sa.idx["LOCALSERVICO"]]||"—",
        TURNO:r[sa.idx["TURNO"]]||"DIURNO",TIPO:r[sa.idx["TIPO"]]||"—",
        SITUACAO:r[sa.idx["SITMOBRAHOJE"]]||"—",EMPRESA:r[sa.idx["EMPRESA"]]||"—",
        // JORNADA traz o horário do posto em texto: "09H 06:30 - 15:30 C/ 1H INT".
        // É a única fonte da hora de abertura, e é o que permite medir quanto
        // tempo o supervisor leva para chegar depois de o posto iniciar.
        JORNADA:r[sa.idx["JORNADA"]]||""
      };
    }
  });
  data.ativos=Object.values(emps).sort((a,b)=>String(a.NOME||"").localeCompare(String(b.NOME||"")));
  // Mantém na ficha de presença apenas quem está no quadro ativo (RE presente em FUNCIONARIOS ATIVOS).
  // Assim funcionários já desligados/transferidos que ainda têm histórico na ficha não inflam a contagem.
  const _activeRE=new Set(data.ativos.map(e=>String(e.RE)));
  data.presenca=(data.presenca||[]).filter(r=>r.RE!=null&&_activeRE.has(String(r.RE)));
  const _cargoMap={
    "PORTEIRO (A)":["AUX  ADM II","AUX ADM II","AUX ADM III","AUX ADM IV","MENSAGEIRO","PORTEIRO I","CONT ACESSO II","PORTEIRO (A)","CONTROLADORA DE ACESSO","FISCAL DE PISO","OPERADORA DE ATENDIMENTO","PORTEIRO LÍDER","PORTEIRO LIDER","PORTEIRO IV","PORTEIRO VI","PORTEIRO III","CONT ACESSO IV","AUXILIAR DE MANUTENCAO","AUXILIAR DE MANUTENÇÃO","RECEPCIONISTA"],
    "AUXILIAR DE SERVIÇOS GERAIS":["AUXILIAR DE SERVIÇOS GERAIS","AUX SERV GERAIS I","AUX SERV  GERAIS I","AUX SERV GERAIS II","AUX SERV GERAIS III","AUX SERV GERAIS IV","AUX SERV GERAIS V","ENCAR LIMPEZA I","ENCARREGADA DE LIMPEZA I","LIDER DE LIMPEZA","LÍDER DE LIMPEZA","PINTOR","TRATORISTA"],
    "ZELADOR":["ZELADOR","ZELADOR I","ZELADOR II","ZELADOR III","ZELADOR IV","ZELADOR IX","ZELADOR V","ZELADOR VI","ZELADOR VII","ZELADOR XI","ZELADOR XII","ZELADOR XIII","ZELADOR XIV","ZELADOR XV","ZELADORA","ZELADOR (A) VI","ZELADOR(A) VI","ZELADOR (A)"],
    "JARDINEIRO":["JARDINEIRO","JARDINEIRO I","JARDINEIRO II","JARDINEIRO III","JARDINEIRO IV","JARDINEIRO V"],
    "ADMINISTRATIVO":["ANALISTA DE DP SENIOR","ANALISTA FINANCEIRO SENIOR","ANALISTA OPERACIONAL","ASSISTENTE ADMINISTRATIVO","ASSISTENTE DEPTO PESSOAL","AUX SUPERVISÃO I - B","AUX SUPERVISAO I - B","COSTUREIRA","CUIDADOR (A)","CUIDADORA","DIRETOR","GERENTE DEPTO FINANCEIRO","GERENTE DEPTO PESSOAL","GERENTE OPERACIONAL","INSPETOR DE QUALIDDE","INSPETOR DE QUALIDADE","QUALIDADE","RECURSOS HUMANOS","SUPERVISOR SENIOR","SUPERVISOR I"]
  };
  const _cargoLookup={};
  function _normCargo(s){return(s||"").toUpperCase().trim().replace(/\s+/g," ");}
  for(const[grupo,cargos] of Object.entries(_cargoMap)){cargos.forEach(c=>{_cargoLookup[_normCargo(c)]=grupo;});}
  data.ativos.forEach(r=>{const u=_normCargo(r.CARGO);if(_cargoLookup[u])r.CARGO=_cargoLookup[u];});
  const ativosMap={};
  const ativosNomeMap={};
  data.ativos.forEach(r=>{
    if(r.RE!=null)ativosMap[String(r.RE)]=r;
    if(r.NOME){const k=String(r.NOME).trim().toUpperCase().replace(/\s+/g," ");ativosNomeMap[k]=r;}
  });
  (data.presenca||[]).forEach(r=>{
    if(!r.TPCLIENTE&&r.RE!=null){const at=ativosMap[String(r.RE)];if(at)r.TPCLIENTE=at.TIPO||at.TPCLIENTE||"";}
  });
  (data.cobertura||[]).forEach(r=>{
    const nm=String(r.NOME||"").trim().toUpperCase().replace(/\s+/g," ");
    const at=ativosNomeMap[nm];
    r.CARGO=at?at.CARGO:"—";
  });
  (data.fts||[]).forEach(r=>{
    const nm=String(r.NOME||"").trim().toUpperCase().replace(/\s+/g," ");
    const at=ativosNomeMap[nm];
    if(at)r.TURNO=at.TURNO||"DIURNO";
  });
  (data.faltas||[]).forEach(r=>{
    const nm=String(r.NOME||"").trim().toUpperCase().replace(/\s+/g," ");
    const at=ativosNomeMap[nm];
    if(at&&!r.TURNO)r.TURNO=at.TURNO||"DIURNO";
  });
  const wsBDV=findSheet(wb,"BDV - LANÇAMENTOS")||findSheet(wb,"BDV LANÇAMENTOS")||findSheet(wb,"BDV LANCAMENTOS");
  if(wsBDV){
    const bdvRows=XLSX.utils.sheet_to_json(wsBDV,{raw:false,defval:""});
    data.bdvCobertura=bdvRows.filter(r=>(r["MOTIVO"]||"").toUpperCase().includes("COBERTURA")).map(r=>{
      const dtRaw=(r["DTHRINICIO"]||r["DATA"]||"").toString().trim();
      const dtMatch=dtRaw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      const dt=dtMatch?(dtMatch[3].length===2?"20"+dtMatch[3]:dtMatch[3])+"-"+String(dtMatch[1]).padStart(2,"0")+"-"+String(dtMatch[2]).padStart(2,"0"):dtRaw;
      return{NOME:r["FUNCIONARIO"]||"—",DATA:dt,DESTINO:r["DESTINO"]||"—",KM:r["KMRODADO"]||"0",TEMPO:r["TEMPO"]||"—",MOTIVO:r["MOTIVO"]||"—",TURNO:"DIURNO",HORARIO:r["HORARIO"]||r["HORÁRIO"]||"—"};
    });
  }else{data.bdvCobertura=[];}
  ext("RESERVAS TECNICAS",(r,I)=>{
    const mot=String(r[I["MOTIVO"]]||r[I["MOTIVOS"]]||"").trim();
    const status=RT_INDISP.has(normTxt(mot))?"INDISPONÍVEL":"TRABALHO";
    return{
      NOME:r[I["FUNCIONARIO"]]||r[I["NOMEFUNCIONARIO"]]||r[I["NOME"]]||"—",
      CARGO:r[I["CARGO"]]||r[I["DESC_CARGO"]]||r[I["CARGOVAGA"]]||"—",
      TURNO:r[I["TURNO"]]||turnoFromEscala(r[I["DESCESCALA"]],r[I["HRENTRADA"]])||"DIURNO",
      MOTIVO:mot||"—",
      STATUS:status
    };
  },"restec");
  // CHECK LIST — deduplicar por CHECKLIST ID (cada checklist = 1 visita)
  const wsCK=findSheet(wb,"CHECK LIST")||findSheet(wb,"CHECKLIST")||findSheet(wb,"Planilha1");
  if(wsCK){
    const{idx:CI,body:cbody}=sheetRows(wsCK);
    const seen=new Set();
    data.checklist=(cbody||[]).filter(r=>r&&r.length).map(r=>{
      const modelo=String(r[CI["MODELO"]]||"").trim().toUpperCase();
      if(!CK_MODELOS.has(modelo))return null;
      const ckId=r[CI["CHECKLIST"]];
      if(!ckId)return null;
      if(seen.has(ckId))return null;
      seen.add(ckId);
      const dh=r[CI["DATAHORA"]];
      let dt="";
      if(typeof dh==="number"){const d=new Date(Math.round((dh-25569)*86400000));dt=d.toISOString().slice(0,10);}
      else dt=isoDate(dh);
      const func=String(r[CI["FUNCIONARIO"]]||r[CI["NOMEFUNCIONARIO"]]||"—").trim();
      const fn=func.toUpperCase();
      const CK_NOT=["RONALDO","PAULO"];
      const turno=CK_NOT.some(n=>fn.includes(n))?"NOTURNO":"DIURNO";
      return{
        DATA:dt,CLIENTE:String(r[CI["NOMECLIENTE"]]||"—").trim(),
        MODELO:String(r[CI["MODELO"]]||"—").trim(),
        FUNCIONARIO:func,
        TURNO:turno
      };
    }).filter(Boolean);
  }else{data.checklist=[];}
  return data;
}

module.exports = { buildDataFromWorkbook, isoDate, turnoFromEscala, normTxt, findSheet, sheetRows };
