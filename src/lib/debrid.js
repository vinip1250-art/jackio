import debridlink from "./debrid/debridlink.js";
import alldebrid from "./debrid/alldebrid.js";
import realdebrid from './debrid/realdebrid.js';
import premiumize from './debrid/premiumize.js';
import torrserver from './debrid/torrserver.js';
// Importações corrigidas (sem chaves, pois agora são export default):
import torbox from './debrid/torbox.js'; 
import hybrid from './debrid/hybrid.js'; 

export {ERROR} from './debrid/const.js';

// Corrigido "hibrid" para "hybrid" e adicionado "torbox"
const debrid = {
  debridlink, 
  alldebrid, 
  realdebrid, 
  premiumize, 
  torrserver, 
  torbox, 
  hybrid 
};

export function instance(userConfig){
  if(!debrid[userConfig.debridId]){
    throw new Error(`Debrid service "${userConfig.debridId}" not exists`);
  }
  
  return new debrid[userConfig.debridId](userConfig);
}

export async function list(){
  const values = [];
  for(const instance of Object.values(debrid)){
    values.push({
      id: instance.id,
      name: instance.name,
      shortName: instance.shortName,
      configFields: instance.configFields
    })
  }
  return values;
}