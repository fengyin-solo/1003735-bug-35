# 水文监测站网管理系统

面向水文监测站点运行、水位流量雨量数据采集、遥测设备维护与数据整编发布的水文站网管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

验收链路测试（去重 / 未完工整批拒绝 / 费用与待办联动 / 幂等 / 越权 / 回退与断点续做）：

```bash
cd frontend
npm run test:acceptance
```

> 若在其它平台拷贝过 `node_modules`（如 macOS 装的包拿到 Linux 上），vite 构建会报
> `Cannot find module '@rollup/rollup-linux-<arch>-gnu'` / esbuild 缺二进制，按当前架构补装
> 可选依赖即可（例如 linux/arm64）：
> `npm install @rollup/rollup-linux-arm64-gnu @esbuild/linux-arm64 --no-save`（版本对齐已装的 rollup/esbuild）。

## 站房维护验收与关联写入

- 维护列表、验收详情、巡检面板按业务键「记录编号」共用同一份去重读取口径，重复导入的行只显示一条，
  并在图例提示被折叠的条数；数据迁移时存储内重复行也会被压实。
- 「通过验收」是唯一写入链路（`src/api/acceptance.ts`）：仅「已完成」可验收，未完工 / 不存在的条目
  整批拒绝（不做任何写入）；费用记录（含从行内「费用支出」迁移的历史费用，`legacy` 标记）联动置为
  已结算，巡检侧「现场复核」待办联动关闭。
- 批量验收按记录编号集合生成批次：同批重复执行幂等（只生效一次）；非验收角色（仅值班管理员/验收员）
  越权整批拒绝；写入异常按本轮快照整批回退；断点（`done/总数`）持久化，修复未完工项后可从断点续做。
- 每个模块页底部都有业务台账（`LedgerPanel`）：总量/待处理/终态、费用台账、关联待办、操作流水。
  顶部可切换值班角色用于演示越权拒绝。

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 监测站点 | `station` | 水文监测站 | 站点编号、站点名称、站点类型 |
| 水位监测 | `waterlevel` | 水位记录 | 记录编号、站点编号、观测时间 |
| 流量监测 | `discharge` | 流量记录 | 记录编号、站点编号、测量方法 |
| 雨量观测 | `rainfall` | 雨量记录 | 记录编号、站点编号、观测时段 |
| 水质检测 | `waterquality` | 水质检测报告 | 报告编号、采样站点、采样时间 |
| 断面测量 | `crosssection` | 断面测量记录 | 记录编号、站点编号、断面名称 |
| 遥测设备 | `telemetry` | 遥测设备 | 设备编号、设备类型、所属站点 |
| 数据整编 | `compilation` | 整编成果 | 成果编号、整编年份、站点编号 |
| 预警阈值 | `warning` | 预警阈值配置 | 配置编号、站点编号、监测类型 |
| 地下水观测 | `groundwater` | 地下水观测记录 | 记录编号、井点编号、观测日期 |
| 蒸发观测 | `evaporation` | 蒸发观测记录 | 记录编号、站点编号、观测日期 |
| 测流缆道 | `cableway` | 测流缆道 | 缆道编号、所属站点、跨度米数 |
| 泥沙监测 | `sediment` | 泥沙监测记录 | 记录编号、站点编号、采样时间 |
| 通讯系统 | `communication` | 通讯设备 | 设备编号、设备类型、所属站点 |
| 站房维护 | `stationhouse` | 站房维护记录 | 记录编号、站点编号、维护类型 |
| 仪器检定 | `calibration` | 仪器检定记录 | 记录编号、仪器编号、仪器名称 |
| 巡检记录 | `inspection` | 巡检记录 | 记录编号、站点编号、巡检日期 |
| 测报方案 | `plan` | 测报方案 | 方案编号、方案名称、适用范围 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `hydrology-monitor-station:entries` 这一项，或调用 `resetModule(模块)`。
