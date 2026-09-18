/**
 * 图形类结构：鱼骨图、矩阵图、放射状（顺时针）思维导图。
 *
 * 这三种的排布规则差异较大，不适合归入堆叠家族，所以各自单列一个文件：
 *   span.ts 三者共用的「实际占位」口径；fishbone / matrix / radial 各一套算法。
 *
 * 本文件只是门面，只再导出原来的公开面，所以 run.ts 等调用点不需要改 import。
 */
export { layoutFishbone } from './graphic/fishbone'
export { layoutMatrix } from './graphic/matrix'
export { layoutRadial } from './graphic/radial'
