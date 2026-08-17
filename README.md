# Easy2ALG

把立创商城器件编号对应的 EasyEDA 封装直接转换为 Cadence Allegro 封装库，不依赖 Altium Designer。

## 使用

1. 第一次启动时确认检测到的 Allegro 版本、实际程序位置和封装库目录。
2. 输入一个或多个立创器件编号。
3. 在预览和自动检查中确认焊盘、丝印、阻焊与钢网规则。
4. 点击“生成选中的封装”。
5. 软件调用已安装的 Allegro 生成并回读检查 `.dra`、`.psm` 和 `.pad` 文件。

支持 Allegro 16.6、17.2、17.4、22.1 和 23.1。Windows 是正式转换平台。软件只会在找到真实的 Allegro 程序，并且目标文件实际生成、检查通过后显示成功。

## 开发

```bash
npm install
npm run dev
npm run build
```

构建 Windows 安装包和免安装版：

```bash
npm run dist:win
```

## 许可

MIT
