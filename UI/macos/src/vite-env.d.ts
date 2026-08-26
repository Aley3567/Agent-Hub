/// <reference types="vite/client" />

/**
 * CSS Module 的类型声明。
 * 每个组件配一个同名 .module.css，写法固定为：
 *   import styles from "./Foo.module.css";
 */
declare module "*.module.css" {
  const cssModuleClasses: Record<string, string>;
  export default cssModuleClasses;
}
