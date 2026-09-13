# 核芯弹射：声音

声音以轻木敲击、细玻璃碎响和短拨弦为基础。普通碰撞保持小而近；稀有掉落、研究完成、首领出场与胜利使用更完整的提示。所有效果来自本地样本，无高频锯齿波连续蜂鸣；音频不改变游戏逻辑或游戏随机序列。

## 素材来源与许可

| 作者与原作 | 使用内容 | 授权与本地记录 |
|---|---|---|
| [Kenney — Impact Sounds](https://kenney.nl/assets/impact-sounds) | `impactWood_light_000/001`、`impactGlass_light_000/001`、`impactSoft_heavy_000`、`impactBell_heavy_000`，共6个OGG | 原作CC0；压缩包原始许可完整保留于 `public/audio/licenses/kenney-impact.txt` |
| [Kenney — Interface Sounds](https://kenney.nl/assets/interface-sounds) | `click_001`、`pluck_001/002`、`confirmation_001`、`open_001`、`maximize_001`、`minimize_001`，共7个OGG | 原作CC0；压缩包原始许可完整保留于 `public/audio/licenses/kenney-interface.txt` |
| [isaiah658 — Ambient Relaxing Loop](https://opengameart.org/content/ambient-relaxing-loop) | `ambient-isaiah658.ogg`，一段24.511秒的合成氛围循环 | 原作CC0；来源、下载链接和许可见 `public/audio/licenses/ambient-isaiah658.txt` |

三组来源均核对作者发布页面，实际下载日期为2026年9月13日。CC0允许商业使用和修改，无强制署名；项目仍自愿保留作者与出处。Kenney原始压缩包链接分别是 [Interface Sounds](https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip) 和 [Impact Sounds](https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip)。14个选用文件约1.4MB，未把整套素材包装入游戏。音频文件保留原始字节，氛围文件仅重命名；调音、声像、包络和滤波在播放时完成。运行时只请求本站 `audio/` 下的文件，支持Vite部署基础路径。

## 混音与反馈

- 直接撞击使用两种轻木样本；击破使用两种玻璃样本。短暂冷却合并密集事件，同一帧内已击破的砖块不再叠加一次普通受击声。击破音高随连击缓慢上扬，增幅有上限。
- 普通拾取为两音拨弦；高级拾取为四音提示；研究与胜利使用各自的短乐句。铸币、弹簧、分球、传送、光束、雷链、裂隙、星阵分别有语义音效，频繁次级触发会限流。
- 首领直接命中偏低、偏柔；召唤与真实生命跨过66%/33%时有一次低沉钟声。首领血量提示受音效开关控制，与背景音乐开关独立。
- 每帧最多选4种提示，最多12个短音声部。优先保留拾取和重大事件；普通撞击不挤掉胜利乐句。声像只沿场地横向轻微移动，避免过强左右跳动。
- 每个样本有3毫秒起音与最长35毫秒收音，降低切头和截尾噪声；末端有温和动态压缩。稀有掉落、首领出场和胜利暂时压低音乐，在0.65秒内恢复。

## 音乐与设置

背景音乐默认关闭，首次开启后才下载并解码底床。五章共用一段氛围音乐，以小幅移调和低通音色区分场地；首领存活时适当展开音色，并加入低音轻拍。低音轻拍归音乐通道，即使关闭音效仍能正常听到音乐，关闭音乐则完整停止。

`sound` / `music` 独立开关；`soundVolume` 默认0.7、`musicVolume` 默认0.35，分别限制在0–1。设置菜单或暂停时，音乐降低到35%，UI点击仍可播放，战斗事件不发声；结算底床降到70%。隐藏网页时全部静音并停止音乐源，回到前台再淡入，不补播后台战斗事件。切换游戏对象、存档或章节时停止旧声音；迟到的解码结果不能重新播放旧场景。首次解锁必须由真实玩家手势触发，遵循浏览器自动播放限制。

## 接入契约

`src/audio.js` 导出 `GameAudio`，配置位于 `src/data/audio.json`。

```js
const audio = new GameAudio(audioConfig);
audio.update(game, { hidden: document.hidden, paused: game.paused });
audio.unlock();              // pointer / keyboard / click 手势中直接调用
audio.events(events, game); // 渲染前转交本帧真实游戏事件，不缓存后台事件
audio.ui('tap');             // tap / buy / error；购买只走ui，不重复播放upgrade事件
audio.destroy();            // 应用实例销毁时清理
```

每帧与页面可见性变化时调用 `update`。音量与暂停状态变化不创建新的AudioContext；全应用复用一个上下文。`status()` 返回解锁状态、已解码数量、当前短音声部数、音乐是否播放和失败文件，加载失败仅记一次控制台警告，不中断游戏。

## 检查边界

所有14个OGG均已通过真实离线解码：44.1kHz，1或2声道，无损坏。普通木/玻璃样本长0.21–0.266秒；底床RMS约−21.2dBFS，首尾单样本差约0.0036。两个拨弦样本起点偏硬，使用播放包络平滑；其中一个原始解码峰值1.05，实际提示的低增益与总线压缩保留混音余量。

当前工具明确不支持模型音频输入，因此以上是解码与信号检查，不是主观试听结论。浏览器实际播放、设备响度与长时间听感须分别记录，不能由波形检查代替。音频生命周期专项位于 `scripts/audio-check.mjs`。

该专项已通过：14个本地资源引用、手势解锁、音乐默认不加载、两通道独立、音乐关闭仍可触发首领损伤提示、密集事件合并和声部上限、单次购买、隐藏/暂停、换章清理、迟到解码及销毁。专项使用轻量音频节点替身验证调度与状态，音频解码结果来自另一轮真实OGG解码；两者不等同于主观听感测试。
