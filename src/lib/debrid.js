import debridlink from "./debrid/debridlink.js";
import alldebrid from "./debrid/alldebrid.js";
import realdebrid from './debrid/realdebrid.js';
import premiumize from './debrid/premiumize.js';
import torrserver from './debrid/torrserver.js';
import torbox from './debrid/torbox.js'; 
import hybrid from './debrid/hybrid.js'; 
import offcloud from './debrid/offcloud.js';
import hybridoc from './debrid/hybrid-oc.js';
import p2p from './debrid/p2p.js'; // ✅ NOVO: P2P sem debrid

export {ERROR} from './debrid/const.js';

// Adicionado "p2p"
const debrid = {
  debridlink, 
  alldebrid, 
  realdebrid, 
  premiumize, 
  torrserver, 
  torbox, 
  hybrid,
  offcloud,
  hybridoc,
  p2p // ✅ NOVO
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
