# OD-Business-Test

与DevFlow并列、构建于TestFlow公开MCP之上的OD业务验收编排工程。测试执行器运行在本地，被测对象是test-server已经部署的服务。本工程不启动业务服务、Mongo或Redis，不提交或部署业务代码。

## 已实现

- 导入106个业务能力目录，并生成小粒度case的批次计划。
- 校验项目归属、固定资产哈希、源码SHA与TestFlow部署观察契约的对应关系、case依赖与循环。
- 通过独立TestFlow MCP进程调用doctor、task、freeze、prepare_remote、execute_remote、status和evidence。
- 前台持久serve保留MCP任务所有者身份；CLI派发后按原jobId观察，不重复创建任务。
- 写入必须匹配prepare返回的精确批准指纹。未知派发/超时不重试，阻塞后续批次。
- 完整选择集和实际断言核验后才归约passed；源码覆盖单独保持unknown。
- 本机账本、配置与host令牌分别保存在忽略目录，原始远端响应正文不写入编排报告。

## 启动

使用Node 22.18以上的22.x，推荐`.nvmrc`指定的22.23.4。`scripts/run.cjs`可在默认Node较旧的机器上查找对应运行时，也支持`OD_BUSINESS_NODE`显式指定。

```sh
node scripts/run.cjs catalog --config .local/config.json
node scripts/run.cjs plan --units AUTH-01,ORD-01 --config .local/config.json
node scripts/run.cjs doctor --config .local/config.json
node scripts/run.cjs serve --config .local/config.json
```

保持serve前台运行，在另一个终端执行：

```sh
node scripts/run.cjs run <计划返回的批次ID> --config .local/config.json
node scripts/run.cjs status <批次ID> --config .local/config.json
node scripts/run.cjs report <批次ID> --config .local/config.json
```

`observe`只核查已知job的证据，不会重放未知请求。若原host退出、派发未拿到jobId或任务结果未知，需要按原TestFlow身份协议人工/主会话核查；本版不自动修复失去所有者的任务，也不删除残留锁或host文件。

## 本机配置与项目资产

`config/deployed.example.json`是不含秘密的配置模板；已生成`.local/config.json`和独立`.local/testflow.workspace.json`，不修改TestFlow/DevFlow原默认workspace。

初始workspace只登记三个项目，尚未登记test-server服务规则、角色和实际部署版本。计划会明确报告remote-environment-missing和case-binding-missing，不能直接执行106项业务。

被测项目的`testing/testflow-local/`已忽略，其中提供`business.config.json`草稿和`adapters/read-asset.cjs`只读资产工厂。它们是项目侧资产入口，不是已实现的业务用例；本版显式将项目case登记到本机配置bindings，尚无自动发现。

配置绑定示意（需替换为实际核对值）：

```json
{
  "unitId": "AUTH-01",
  "caseId": "staff-identity-read",
  "owner": "be",
  "assetsFile": "testing/testflow-local/cases/staff-identity-read.json",
  "assetsHash": "实际文件SHA256",
  "authorization": "login-and-read",
  "needs": []
}
```

项目`deployedSha`必须对应独立TestFlow workspace中该项目`versionId`指向的版本观察项expected。实际部署版本由TestFlow在prepare和执行窗口核验。仅观察版本端点不代表每条业务响应都来自同一实例；实例落点及源码路径覆盖仍为unknown。

资产从项目专用目录校验并按内容寻址复制到该独立workspace的`.testflow/project-assets/od-business-test/`，不依赖Git收集忽略文件。每节点只接受一个remote-http-v1 case；TestFlow规则、认证与断言继续由原执行器校验。

凭据只通过TestFlow受控env引用使用；需要传入MCP进程的环境变量名显式列入`testflow.envFrom`，配置中不放密码或token。

## 第一版边界

- 已实现的是API业务任务编排；真实部署浏览器执行、动态ID跨节点数据传递、跨机器资源锁尚未实现。
- 本机只允许一个控制器及一个活动批次。此锁不证明其他workspace、DevFlow或其他机器不会同时修改同一远端对象。
- 业务断言、环境缺口、未知结果和清理分别报告；清理pending不会被写成completed。
- 编排账本只保留ID和短摘要，TestFlow原始证据按其task finish生命周期清理。`.testflow`暂存源资产按原始测试资产管理，不作为长留运行正文。
- 项目目录中的源码映射尚未与实际部署版本核对。106是能力单元数，不是可执行case数或通过数。

## 自测

项目协议自测位于本机忽略的`testing/testflow-local/`，通过显式补充资产接入TestFlow独立Jest单测，不创建数据库。`npm run test:protocol`是便于调试的宿主Jest检查；与TestFlow隔离执行及test-server业务验收分别报告。

```sh
npm run build
npm run test:protocol
```

以上npm命令需已切换到Node22。TestFlow准备和执行需要本机登记的独立配置与固定依赖镜像，不能只凭构建或doctor成功声称业务通过。
