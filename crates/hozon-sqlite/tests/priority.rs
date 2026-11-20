use hozon_sqlite::{OpenOptions, Registry, WritePriority};
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn priority_fifo_fairness_and_no_preemption() {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    let holder = registry.begin_write(db, None).unwrap();
    let (send, receive) = mpsc::channel();
    for (name, priority) in [
        ("low0".to_owned(), WritePriority::Low),
        ("low1".to_owned(), WritePriority::Low),
    ]
    .into_iter()
    .chain((0..20).map(|i| (format!("high{i}"), WritePriority::High)))
    {
        let send = send.clone();
        registry.begin_write_with_priority_async(
            db,
            None,
            None,
            priority,
            Box::new(move |result| {
                send.send((name, result.unwrap())).unwrap();
            }),
        );
    }
    assert!(receive.try_recv().is_err());
    registry.commit(db, holder.tx_id).unwrap();
    let mut order = Vec::new();
    for _ in 0..22 {
        let (name, admission) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        order.push(name);
        registry.commit(db, admission.tx_id).unwrap();
    }
    assert_eq!(order[0], "high0");
    assert_eq!(order.iter().position(|name| name == "low0"), Some(7));
    assert_eq!(order.iter().position(|name| name == "low1"), Some(16));
    assert_eq!(
        order
            .iter()
            .filter(|name| name.starts_with("high"))
            .cloned()
            .collect::<Vec<_>>(),
        (0..20).map(|i| format!("high{i}")).collect::<Vec<_>>()
    );
    assert_eq!(
        order
            .iter()
            .filter(|name| name.starts_with("low"))
            .cloned()
            .collect::<Vec<_>>(),
        vec!["low0", "low1"]
    );
    registry.close(db).unwrap();
}

#[test]
fn high_request_does_not_preempt_a_running_low_transaction() {
    let registry = Registry::new();
    let db = registry.open(":memory:", OpenOptions::default()).unwrap();
    let (send, receive) = mpsc::channel();
    registry.begin_write_with_priority_async(
        db,
        None,
        None,
        WritePriority::Low,
        Box::new(move |result| {
            send.send(result.unwrap()).unwrap();
        }),
    );
    let holder = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    let (send, receive) = mpsc::channel();
    registry.begin_write_with_priority_async(
        db,
        None,
        None,
        WritePriority::High,
        Box::new(move |result| {
            send.send(result.unwrap()).unwrap();
        }),
    );
    assert!(receive.try_recv().is_err());
    registry
        .execute(
            db,
            Some(holder.tx_id),
            "CREATE TABLE retained (id INTEGER)",
            &[],
            hozon_sqlite::Mode::Write,
        )
        .unwrap();
    assert!(receive.try_recv().is_err());
    registry.commit(db, holder.tx_id).unwrap();
    let high = receive.recv_timeout(Duration::from_secs(5)).unwrap();
    registry.commit(db, high.tx_id).unwrap();
    registry.close(db).unwrap();
}
