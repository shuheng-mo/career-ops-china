---
schema_version: 1
block_id: demo.query-permission
revision: 1
kind: qa
project: demo
status: active
tracks: [ai-app]
rounds: [technical]
questions:
  - 你如何限制查询权限？
  - 怎样防止越权读取数据？
anchors: [身份识别, 权限过滤, 执行校验]
fact_refs: ["tech:demo.permission"]
claim_kind: experience
related: [demo.audit]
criticality: high
pinned: false
source_refs:
  - {artifact_id: import-demo, locator: 'lines:12-24'}
rubric:
  required:
    - {id: p1, text: 明确说明权限检查时机, weight: 2}
    - {id: p2, text: 说明实际能力的边界, weight: 1}
  forbidden:
    - {id: f1, text: 声称已经实现未经验证的权限功能, severity: major}
---
## 30 秒版
示例答案：先做身份识别，再按角色过滤表和列，最后执行前校验 SQL，只放行 SELECT。
## 详细版
示例答案与设计依据：权限在意图识别阶段解析为租户与角色，SQL 生成时注入过滤条件，执行前再校验一次；所有查询写审计日志。
## 技术边界
哪些做过、哪些未做：做过角色级表/字段隔离与 SELECT-only 白名单；未做行级数据脱敏。
