package com.example.demo.task;

import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

// Spring Data writes the SQL for these methods from their names.
public interface TaskRepository extends JpaRepository<Task, Long> {

    List<Task> findByDoneOrderByIdAsc(boolean done);

    boolean existsByTitleIgnoreCase(String title);
}
