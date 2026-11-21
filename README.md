# 单据核对台 · Document Reconciliation

在运行组件的智能体中清洗 CSV 或 TSV，复核低置信度行，确认对账并导出 CSV。

市场版本提供配置和启动入口，运行权限通过独立组件或 MCP 单独授权。

## 运行

在 AGH 中另行安装运行组件，审核权限后启用。

```sh
agh plugins add git:https://github.com/wblxr408/agh-plugin-messy-etl#13b00e66dd30a831593097b307e231058b2e3f96
```

从「智能体」启动运行组件自己的入口 `@wblxr408/messy-etl-runtime#etl`。在运行组件的智能体中清洗 CSV 或 TSV，复核低置信度行，确认对账并导出 CSV。
表格导入参数为 CSV/TSV 的文本。可在会话中提供文件并让智能体读取和解析。确认批次后从核对台导出。

[运行组件源代码](https://github.com/wblxr408/agh-plugin-messy-etl/tree/runtime-v1.0.0)
