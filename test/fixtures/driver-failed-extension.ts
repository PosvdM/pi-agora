// 仅供驱动启动失败测试加载。
export default function () {
  throw new Error("受控扩展加载失败");
}
