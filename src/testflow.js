import {invariant} from './core.js';

const allowed = ['doctor','remote_doctor','task','freeze','prepare_remote','execute_remote','status','evidence'];
export class TestFlow {
  constructor(client, workspaceFile) {this.client=client;this.workspaceFile=workspaceFile;}
  static async connect(config) {
    const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
    const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client=new Client({name:'od-business-test',version:'0.1.0'});
    const env={};for(const key of config.envFrom??[]){invariant(/^[A-Z][A-Z0-9_]*$/.test(key)&&process.env[key]!==undefined,'credential-environment-reference-unavailable');env[key]=process.env[key];}
    const transport=new StdioClientTransport({command:config.command,args:config.args,stderr:'pipe',env});
    // 不转发插件原始stderr；父进程日志不记录凭据或响应正文。
    try{await client.connect(transport);}catch{await transport.close();throw Error('testflow-connection-failed');}
    const tf=new TestFlow(client,config.workspaceFile);
    const listed=await client.listTools();tf.tools=new Set(listed.tools.map(t=>t.name));
    try{for(const name of allowed)invariant(tf.tools.has(`testflow_${name}`),'testflow-tool-missing:'+name);}catch(error){await client.close();throw error;}
    return tf;
  }
  async call(name,args={}) {
    invariant(allowed.includes(name),'testflow-tool-not-allowed');
    const r=await this.client.callTool({name:`testflow_${name}`,arguments:{...args,workspaceFile:this.workspaceFile}},undefined,{timeout:300000});
    invariant(!r.isError,'testflow-call-rejected:'+name);
    if(r.structuredContent)return r.structuredContent;
    const item=r.content?.find(c=>c.type==='text');
    invariant(item,'testflow-json-response-required');return JSON.parse(item.text);
  }
  async close(){await this.client.close();}
}
