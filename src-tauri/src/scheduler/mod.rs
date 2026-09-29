//! Python scripts the user scheduled to run by themselves: when each fires (`plan`, pure) and the
//! task that starts them (`engine`). Schedules are kept by `store::schedules`.

pub mod engine;
pub mod plan;
